import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, parseConfig, type Config } from "../src/config.ts";
import { NO_EXCEPTIONS, parseExceptions, type Exceptions } from "../src/exceptions.ts";
import type { Fetch } from "../src/http.ts";
import { NpmCatalog } from "../src/catalogs.ts";
import { npmChanges } from "../src/npm-changes.ts";
import { isYoung, releaseAgeProblems } from "../src/release-age.ts";
import { gatherCandidates } from "../src/young-fixes.ts";
import { bundleProblems, changedPackages, lockedPackages, sourceProblems } from "../src/npm-lock.ts";
import { NpmRegistry } from "../src/npm-registry.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";

const NOW = new Date("2026-10-04T12:00:00Z");

/** Synthetic tarball digest of `name@version`, the same in lockfiles and provenance statements. */
const sha512 = (key: string) => createHash("sha512").update(key).digest();

/** Synthetic lockfile: package name → version, each resolved from the registry. */
function lock(entries: Record<string, string>, extra: Record<string, object> = {}): unknown {
  const packages: Record<string, object> = { "": { name: "app" } };
  for (const [name, version] of Object.entries(entries)) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
      integrity: `sha512-${sha512(`${name}@${version}`).toString("base64")}`,
    };
  }
  return { lockfileVersion: 3, packages: { ...packages, ...extra } };
}

const pkgs = (entries: Record<string, string>, extra?: Record<string, object>) => lockedPackages(lock(entries, extra));

const ATTESTATIONS = "https://registry.npmjs.org/-/npm/v1/attestations/";
const SLSA = "https://slsa.dev/provenance/v1";

type Body = { ok: boolean; status: number; body: unknown };

function respond({ ok, status, body }: Body): Awaited<ReturnType<Fetch>> {
  return { ok, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

/**
 * Fake registry. `times` gives registry publish times (one manifest per listed
 * version, declaring github.com/acme/<name>); `sources` gives the
 * `name@version`s with SLSA provenance, as "repository workflow-path";
 * `publishers` overrides the default publisher ("maintainer").
 */
function fake(options: { times?: Record<string, Record<string, string>>; sources?: Record<string, string>; publishers?: Record<string, string> }): Fetch {
  return async (url) => {
    if (url.startsWith(ATTESTATIONS)) {
      const key = decodeURIComponent(url.slice(ATTESTATIONS.length));
      const source = options.sources?.[key];
      if (source === undefined) return respond({ ok: false, status: 404, body: {} });
      const [repository, path] = source.split(" ");
      const subject = [{ name: `pkg:npm/${key.replace(/^@/, "%40")}`, digest: { sha512: sha512(key).toString("hex") } }];
      const statement = { subject, predicate: { buildDefinition: { externalParameters: { workflow: { repository, path } } } } };
      const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
      const attestations = [
        { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: {} },
        { predicateType: SLSA, bundle: { dsseEnvelope: { payload } } },
      ];
      return respond({ ok: true, status: 200, body: { attestations } });
    }
    const name = decodeURIComponent(url.slice("https://registry.npmjs.org/".length));
    const time = options.times?.[name];
    if (time === undefined) return respond({ ok: false, status: 404, body: {} });
    const manifest = (version: string) => {
      const key = `${name}@${version}`;
      const provenance =
        options.sources?.[key] === undefined ? {} : { attestations: { url: `${ATTESTATIONS}${key}`, provenance: { predicateType: SLSA } } };
      return {
        repository: { type: "git", url: `git+https://github.com/acme/${name}.git` },
        _npmUser: { name: options.publishers?.[key] ?? "maintainer" },
        dist: provenance,
      };
    };
    const versions = Object.fromEntries(Object.keys(time).map((version) => [version, manifest(version)]));
    return respond({ ok: true, status: 200, body: { time, versions } });
  };
}

const registry = (body: unknown): Fetch => async () => respond({ ok: true, status: 200, body });

describe("npm candidate catalog", () => {
  it("excludes every nonempty deprecation message while keeping cleared deprecations and base publish times", async () => {
    let reads = 0;
    const fetch = registry({ time: { "1.0.0": "2026-01-01T00:00:00Z" }, versions: {
      "1.0.0": { deprecated: "Accidental release" }, "1.0.1": { deprecated: " " },
      "1.0.2": { deprecated: "" }, "1.0.3": {},
    } });
    const catalog = new NpmCatalog(new NpmRegistry(async (...args) => { reads++; return fetch(...args); }));
    expect(await catalog.versions({ ecosystem: "npm", name: "lib" })).toEqual(["1.0.2", "1.0.3"]);
    expect(await catalog.published({ ecosystem: "npm", name: "lib", version: "1.0.0" })).toEqual(new Date("2026-01-01"));
    expect(reads).toBe(1);
  });
});

/** A snapshot from `name@version` → advisories; every version not listed (and every candidate) has none. */
function snapshot(
  affecting: Record<string, Advisory[]>,
  packages: ReadonlyArray<{ name: string; version: string }>,
): Snapshot {
  const map = new Map<string, Advisory[]>();
  for (const pkg of packages) map.set(`npm|${pkg.name}|${pkg.version}`, []);
  for (const [key, advisories] of Object.entries(affecting)) {
    const at = key.lastIndexOf("@");
    map.set(`npm|${key.slice(0, at)}|${key.slice(at + 1)}`, advisories);
  }
  return new Snapshot(map, [], NOW);
}

const advisory = (id: string, options: Partial<Advisory> = {}): Advisory => ({
  id,
  ids: [id],
  source: "osv",
  malicious: false,
  summary: undefined,
  severity: undefined,
  ...options,
});

/** The npm half of `compare`: source and identity problems, then the release-age rule over one snapshot. */
async function changes(
  base: ReturnType<typeof pkgs>,
  head: ReturnType<typeof pkgs>,
  fetch: Fetch,
  options: { exceptions?: Exceptions; config?: Config; affecting?: Record<string, Advisory[]> } = {},
) {
  const config = options.config ?? DEFAULT_CONFIG;
  const exceptions = options.exceptions ?? NO_EXCEPTIONS;
  const registry = new NpmRegistry(fetch);
  const npm = await npmChanges(base, head, { registry, exceptions, config, now: NOW });
  const young = npm.changes.filter((change) => isYoung(change, config, NOW));
  const catalogs = { npm: new NpmCatalog(registry), Maven: new NpmCatalog(registry), "GitHub Actions": new NpmCatalog(registry) };
  const candidates = await gatherCandidates(young, catalogs, config);
  const snap = snapshot(options.affecting ?? {}, [...base, ...head, ...candidates.versions]);
  const age = await releaseAgeProblems(young, { snapshot: snap, exceptions, config, now: NOW, catalogs, candidates: candidates.byChange });
  return [...npm.problems, ...age];
}

describe("lockfile reading", () => {
  it("reads nested packages by their own name and aliases by the real package, skipping links and the root", () => {
    const parsed = pkgs(
      { left: "1.0.0", "@scope/pkg": "2.0.0" },
      {
        "node_modules/left/node_modules/inner": { version: "0.1.0", resolved: "https://registry.npmjs.org/inner/-/inner-0.1.0.tgz" },
        "node_modules/alias": { name: "real-name", version: "3.0.0", resolved: "https://registry.npmjs.org/real-name/-/real-name-3.0.0.tgz" },
        "node_modules/local": { link: true, resolved: "packages/local" },
      },
    );
    expect(parsed.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(["left@1.0.0", "@scope/pkg@2.0.0", "inner@0.1.0", "real-name@3.0.0"]);
  });

  it("rejects old lockfile formats, malformed maps and entries, and entries without a version", () => {
    expect(() => lockedPackages({ lockfileVersion: 1, dependencies: {} })).toThrow(/lockfileVersion 2 or 3/);
    for (const packages of [[], false, 42, null, "x"]) {
      expect(() => lockedPackages({ lockfileVersion: 3, packages })).toThrow(/lockfileVersion 2 or 3 with a `packages` map/);
    }
    expect(() => lockedPackages(null)).toThrow(/lockfileVersion 2 or 3/);
    expect(() => lockedPackages({ lockfileVersion: 3, packages: { "node_modules/x": "1.0.0" } })).toThrow(/node_modules\/x isn't an object/);
    expect(() => lockedPackages({ lockfileVersion: 3, packages: { "node_modules/x": {} } })).toThrow(/has no version/);
  });

  it("reports new packages and changed versions, including transitive ones", () => {
    const changed = changedPackages(pkgs({ a: "1.0.0", b: "1.0.0" }), pkgs({ a: "1.0.0", b: "1.1.0", c: "3.0.0" }));
    expect(changed.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(["b@1.1.0", "c@3.0.0"]);
  });

  it("checks bundled packages' source through the parent that ships them", () => {
    const bundled = { version: "5.0.9", inBundle: true };
    const parsed = pkgs({ cdk: "2.0.0" }, { "node_modules/cdk/node_modules/brace-expansion": bundled });
    expect(sourceProblems(parsed)).toEqual([]);
    expect(parsed.find((pkg) => pkg.name === "brace-expansion")!.bundled).toBe(true);
    // `inBundle` can't excuse a package that no locked package ships.
    expect(() => pkgs({}, { "node_modules/brace-expansion": bundled })).toThrow(/no locked package ships it/);
    expect(() => pkgs({}, { "node_modules/gone/node_modules/brace-expansion": bundled })).toThrow(/no locked package ships it/);
    expect(() => pkgs({}, { "packages/ws": { version: "1.0.0" }, "packages/ws/node_modules/brace-expansion": bundled })).toThrow(
      /no locked package ships it/,
    );
    expect(() => pkgs({}, { "node_modules/orphan": bundled, "node_modules/orphan/node_modules/brace-expansion": bundled })).toThrow(
      /no locked package ships it/,
    );
    // A workspace link isn't a shipped package either.
    expect(() =>
      pkgs({}, { "node_modules/ws": { resolved: "packages/ws", link: true }, "node_modules/ws/node_modules/brace-expansion": bundled }),
    ).toThrow(/no locked package ships it/);
  });

  it("follows bundles nested in bundles up to the shipping package", () => {
    const parsed = pkgs(
      { cdk: "2.0.0" },
      {
        "node_modules/cdk/node_modules/minimatch": { version: "10.2.5", inBundle: true },
        "node_modules/cdk/node_modules/minimatch/node_modules/evil": { version: "1.0.0", inBundle: true },
      },
    );
    expect(sourceProblems(parsed)).toEqual([]);
    const scoped = pkgs(
      { "@aws-cdk/schema": "1.0.0" },
      {
        "node_modules/@aws-cdk/schema/node_modules/@scope/inner": { version: "2.0.0", inBundle: true },
        "node_modules/@aws-cdk/schema/node_modules/@scope/inner/node_modules/@x/leaf": { version: "3.0.0", inBundle: true },
      },
    );
    expect(sourceProblems(scoped).length).toBe(0);
    expect(() => pkgs({}, { "node_modules/@aws-cdk/gone/node_modules/@scope/inner": { version: "2.0.0", inBundle: true } })).toThrow(
      /no locked package ships it/,
    );
  });

  it("fails a bundle whose shipped closure the lockfile doesn't fully record, transitive dependencies included", () => {
    const cdk = { version: "2.0.0", bundleDependencies: ["minimatch", "semver"] };
    const minimatch = { version: "10.2.5", inBundle: true, dependencies: { "brace-expansion": "^5.0.5" } };
    const complete = {
      "node_modules/cdk": cdk,
      "node_modules/cdk/node_modules/minimatch": minimatch,
      "node_modules/cdk/node_modules/brace-expansion": { version: "5.0.9", inBundle: true },
      "node_modules/cdk/node_modules/semver": { version: "7.7.2", inBundle: true },
    };
    expect(bundleProblems(lock({}, complete))).toEqual([]);

    // The vulnerable copy dropped while every declared bundle stays: still incomplete.
    const { "node_modules/cdk/node_modules/brace-expansion": _brace, ...withoutBrace } = complete;
    expect(bundleProblems(lock({}, withoutBrace))).toEqual([
      "node_modules/cdk ships brace-expansion (needed by node_modules/cdk/node_modules/minimatch), but the lockfile has no inBundle entry for it there",
    ]);

    // Every bundled entry gone (what `--package-lock-only` can write): each declared bundle is missing.
    expect(bundleProblems(lock({}, { "node_modules/cdk": cdk }))).toEqual([
      "node_modules/cdk ships minimatch (needed by node_modules/cdk), but the lockfile has no inBundle entry for it there",
      "node_modules/cdk ships semver (needed by node_modules/cdk), but the lockfile has no inBundle entry for it there",
    ]);

    // A copy outside the bundle doesn't count: the tarball ships its own.
    const { "node_modules/cdk/node_modules/semver": _semver, ...withoutBundledSemver } = complete;
    expect(bundleProblems(lock({ semver: "7.7.2" }, withoutBundledSemver))).toEqual([
      "node_modules/cdk ships semver (needed by node_modules/cdk), but the lockfile has no inBundle entry for it there",
    ]);
  });

  it("reads `bundleDependencies: true` as every dependency, and lets optional dependencies be absent", () => {
    const packages = {
      "node_modules/tool": { version: "1.0.0", bundleDependencies: true, dependencies: { a: "^1" }, optionalDependencies: { b: "^1" } },
      "node_modules/tool/node_modules/a": { version: "1.0.0", inBundle: true },
    };
    expect(bundleProblems(lock({}, packages))).toEqual([]);
    expect(bundleProblems(lock({}, { "node_modules/tool": packages["node_modules/tool"] }))).toEqual([
      "node_modules/tool ships a (needed by node_modules/tool), but the lockfile has no inBundle entry for it there",
    ]);
  });

  it("flags packages that don't come from an allowed registry", () => {
    const git = pkgs({}, { "node_modules/fork": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/fork.git#abc" } });
    expect(sourceProblems(git)).toEqual([
      "fork@1.0.0 (node_modules/fork) doesn't come from an allowed registry as its own tarball: git+ssh://git@github.com/x/fork.git#abc",
    ]);
    const internal = pkgs({}, { "node_modules/own": { version: "1.0.0", resolved: "https://npm.acme.dev/own/-/own-1.0.0.tgz" } });
    expect(sourceProblems(internal)).toHaveLength(1);
    expect(sourceProblems(internal, ["https://registry.npmjs.org", "https://npm.acme.dev"])).toEqual([]);
    // Another package's tarball can't pass as this one, on npm's registry or another allowed one.
    const swapped = pkgs({}, {
      "node_modules/safe": { version: "1.0.0", resolved: "https://registry.npmjs.org/attacker/-/attacker-1.0.0.tgz" },
      "node_modules/@acme/own": { version: "1.0.0", resolved: "https://registry.npmjs.org/@acme/own/-/own-1.0.1.tgz" },
      "node_modules/other": { version: "1.0.0", resolved: "https://npm.acme.dev/attacker/-/attacker-1.0.0.tgz" },
    });
    expect(sourceProblems(swapped, ["https://registry.npmjs.org", "https://npm.acme.dev"]).map((problem) => problem.split(" ")[0])).toEqual(["safe@1.0.0", "@acme/own@1.0.0", "other@1.0.0"]);
    const scoped = pkgs({}, { "node_modules/@acme/own": { version: "1.0.0", resolved: "https://registry.npmjs.org/@acme/own/-/own-1.0.0.tgz" } });
    expect(sourceProblems(scoped)).toEqual([]);
  });
});

describe("release age", () => {
  it("passes versions at least 7 days old (boundary included) and fails younger ones, transitive or not", async () => {
    const fetch = fake({ times: { old: { "1.0.0": "2026-09-27T12:00:00Z" }, young: { "2.0.0": "2026-10-02T00:00:00Z" } } });
    expect(await changes([], pkgs({ old: "1.0.0", young: "2.0.0" }), fetch)).toEqual([
      "young@2.0.0 was published 2026-10-02T00:00:00.000Z (2.5 days ago, under 7), and it isn't the security fix the version rule would take: it's new here, not a fix of an earlier version",
    ]);
  });

  it("uses the configured wait and lets own packages skip it", async () => {
    const fetch = fake({ times: { young: { "2.0.0": "2026-10-02T00:00:00Z" }, "@acme/own": { "1.0.0": "2026-10-04T11:00:00Z" } } });
    const head = pkgs({ young: "2.0.0", "@acme/own": "1.0.0" });
    const config = parseConfig({ releaseAgeDays: 2, ownPackages: { npm: { scopes: ["@acme"] } } });
    expect(await changes([], head, fetch, { config })).toEqual([]);
  });

  it("doesn't need an own package's publish time", async () => {
    const odd = registry({ time: { "1.0.0": "not a date" }, versions: { "1.0.0": { _npmUser: { name: "m" }, dist: {} } } });
    const config = parseConfig({ ownPackages: { npm: { scopes: ["@acme"] } } });
    expect(await changes([], pkgs({ "@acme/own": "1.0.0" }), odd, { config })).toEqual([]);
  });

  it("ignores packages the change doesn't touch", async () => {
    const same = pkgs({ untouched: "1.0.0" });
    expect(await changes(same, same, fake({}))).toEqual([]);
  });

  it("checks the age of a bundle's shipping package, not of what it bundles", async () => {
    const cdk = (version: string) => pkgs({ cdk: version }, { "node_modules/cdk/node_modules/minimatch": { version: "10.2.5", inBundle: true } });
    const fetch = fake({ times: { cdk: { "2.0.0": "2026-01-01T00:00:00Z", "2.1.0": "2026-10-03T00:00:00Z" } } });
    expect(await changes(cdk("2.0.0"), cdk("2.1.0"), fetch)).toEqual([
      "cdk@2.1.0 was published 2026-10-03T00:00:00.000Z (1.5 days ago, under 7), and it isn't the security fix the version rule would take: it fixes no advisory affecting 2.0.0",
    ]);
  });

  it("fails a package from another allowed registry, and needs a reviewed identity exception even for an own one", async () => {
    const head = pkgs({}, { "node_modules/@acme/x": { version: "1.0.0", resolved: "https://npm.acme.dev/@acme/x/-/x-1.0.0.tgz" } });
    const registries = ["https://registry.npmjs.org", "https://npm.acme.dev"];
    expect(await changes([], head, fake({}), { config: parseConfig({ npm: { registries } }) })).toEqual([
      "@acme/x@1.0.0 comes from https://npm.acme.dev/@acme/x/-/x-1.0.0.tgz, where the gate can't check its release age or publisher identity",
    ]);
    const own = parseConfig({ npm: { registries }, ownPackages: { npm: { scopes: ["@acme"] } } });
    expect(await changes([], head, fake({}), { config: own })).toEqual([
      "@acme/x@1.0.0 comes from https://npm.acme.dev/@acme/x/-/x-1.0.0.tgz, where the gate can't check its publisher identity; an identity exception records the review",
    ]);
    const reviewed = (expires: string) =>
      parseExceptions({ identity: [{ package: "@acme/x", version: "1.0.0", reason: "our CI published it", expires }] });
    expect(await changes([], head, fake({}), { config: own, exceptions: reviewed("2026-10-04") })).toEqual([]);
    expect(await changes([], head, fake({}), { config: own, exceptions: reviewed("2026-10-03") })).toHaveLength(1);
  });

  describe("security exception", () => {
    const base = pkgs({ lib: "1.0.0" });
    const head = pkgs({ lib: "1.0.1" });
    const fetch = fake({ times: { lib: { "1.0.1": "2026-10-03T00:00:00Z" } } });
    const exception = (advisoryId: string, expires = "2026-10-31") =>
      parseExceptions({ releaseAge: [{ package: "lib", version: "1.0.1", advisory: advisoryId, reason: "fixes it", expires }] });

    it("accepts a young version the version rule picks, with no exception", async () => {
      const affecting = { "lib@1.0.0": [advisory("GHSA-fix", { ids: ["GHSA-fix", "CVE-2026-1"] })] };
      expect(await changes(base, head, fetch, { affecting })).toEqual([]);
    });

    it("accepts a young version by an exception naming any alias of an advisory it fixes, where the proof can't", async () => {
      // An aged 1.0.2 fixes it too, so the rule picks 1.0.2: only a reviewed exception can justify the young 1.0.1.
      const withAged = fake({ times: { lib: { "1.0.1": "2026-10-03T00:00:00Z", "1.0.2": "2026-09-01T00:00:00Z" } } });
      const affecting = { "lib@1.0.0": [advisory("GHSA-fix", { ids: ["GHSA-fix", "CVE-2026-1"] })] };
      expect(await changes(base, head, withAged, { affecting })).toEqual([
        "lib@1.0.1 was published 2026-10-03T00:00:00.000Z (1.5 days ago, under 7), and it isn't the security fix the version rule would take: 1.0.2 fixes GHSA-fix too and is at least 7 days old (line 1)",
      ]);
      expect(await changes(base, head, withAged, { exceptions: exception("GHSA-fix"), affecting })).toEqual([]);
      expect(await changes(base, head, withAged, { exceptions: exception("CVE-2026-1"), affecting })).toEqual([]);
    });

    it("rejects an advisory that doesn't affect the replaced version, still affects the new one, or is malware", async () => {
      expect(await changes(base, head, fetch, { exceptions: exception("GHSA-old") })).toEqual([
        "lib@1.0.1: advisory GHSA-old doesn't affect the replaced version(s) 1.0.0",
      ]);
      const notFixed = { "lib@1.0.0": [advisory("GHSA-fix")], "lib@1.0.1": [advisory("GHSA-fix")] };
      expect(await changes(base, head, fetch, { exceptions: exception("GHSA-fix"), affecting: notFixed })).toEqual([
        "lib@1.0.1: advisory GHSA-fix still affects 1.0.1",
      ]);
      const malware = { "lib@1.0.0": [advisory("GHSA-m", { malicious: true })] };
      expect(await changes(base, head, fetch, { exceptions: exception("GHSA-m"), affecting: malware })).toEqual([
        "lib@1.0.1: advisory GHSA-m is a malware entry",
      ]);
    });

    it("rejects an expired exception and an exception for a version that removes nothing", async () => {
      const affecting = { "lib@1.0.0": [advisory("GHSA-fix")] };
      expect(await changes(base, head, fetch, { exceptions: exception("GHSA-old", "2026-10-03") })).toEqual([
        "lib@1.0.1: its release-age exception expired on 2026-10-03",
      ]);
      expect(await changes([], head, fetch, { exceptions: exception("GHSA-fix"), affecting })).toEqual([
        "lib@1.0.1: advisory GHSA-fix can't justify it: the change removes no lib version",
      ]);
    });

    it("binds the advisory to a copy the change removes, not to one it keeps", async () => {
      const affecting = { "lib@1.0.0": [advisory("GHSA-fix")] };
      const nested = (dir: string, version: string) => ({
        [`node_modules/${dir}/node_modules/lib`]: { version, resolved: `https://registry.npmjs.org/lib/-/lib-${version}.tgz` },
      });
      const before = pkgs({ a: "1.0.0", b: "1.0.0" }, nested("a", "1.0.0"));

      // The vulnerable copy under `a` stays; a new copy under `b` can't borrow its advisory.
      const keptOld = pkgs({ a: "1.0.0", b: "1.0.0" }, { ...nested("a", "1.0.0"), ...nested("b", "1.0.1") });
      expect(await changes(before, keptOld, fetch, { exceptions: exception("GHSA-fix"), affecting })).toEqual([
        "lib@1.0.1: advisory GHSA-fix can't justify it: the change removes no lib version",
      ]);

      // The vulnerable copy is gone and npm hoisted the fixed version: that's a replacement.
      const hoisted = pkgs({ a: "1.0.0", b: "1.0.0", lib: "1.0.1" });
      expect(await changes(before, hoisted, fetch, { exceptions: exception("GHSA-fix"), affecting })).toEqual([]);
    });
  });

  it("fails sources it can't check and fails closed on a missing or malformed publish time", async () => {
    const git = pkgs({}, { "node_modules/fork": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/fork.git#abc" } });
    expect(await changes([], git, fake({}))).toEqual([
      "fork@1.0.0 (node_modules/fork) doesn't come from an allowed registry as its own tarball: git+ssh://git@github.com/x/fork.git#abc",
    ]);
    await expect(changes([], pkgs({ gone: "1.0.0" }), fake({}))).rejects.toThrow(/HTTP 404/);
    for (const time of ["not a date", "2026", null, 0, false, 1_700_000_000_000]) {
      const odd = registry({ time: { "1.0.0": time }, versions: { "1.0.0": { _npmUser: { name: "m" }, dist: {} } } });
      await expect(changes([], pkgs({ odd: "1.0.0" }), odd)).rejects.toThrow(/no valid publish time/);
    }
    await expect(changes([], pkgs({ odd: "1.0.0" }), registry({ time: "2020-01-01T00:00:00Z", versions: {} }))).rejects.toThrow(/malformed/);
  });
});

describe("publisher identity", () => {
  const base = pkgs({ lib: "1.0.0" });
  const head = pkgs({ lib: "1.1.0" });
  const times = { lib: { "1.0.0": "2026-01-01T00:00:00Z", "1.1.0": "2026-09-01T00:00:00Z" } };
  const RELEASE = "https://github.com/acme/lib .github/workflows/release.yml";
  const accepted = (expires: string) => parseExceptions({ identity: [{ package: "lib", version: "1.1.0", reason: "moved CI", expires }] });

  it("fails a version without provenance that replaces one with it, unless an unexpired exception accepts it", async () => {
    const dropped = fake({ times, sources: { "lib@1.0.0": RELEASE } });
    expect(await changes(base, head, dropped)).toEqual(["lib@1.1.0 has no provenance, but the version it replaces (1.0.0) had it"]);
    expect(await changes(base, head, dropped, { exceptions: accepted("2026-10-04") })).toEqual([]);
    expect(await changes(base, head, dropped, { exceptions: accepted("2026-10-03") })).toEqual([
      "lib@1.1.0: its identity exception expired on 2026-10-03",
    ]);
  });

  it("fails provenance naming another source repository or workflow, even for an old version", async () => {
    const moved = (source: string) => fake({ times, sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": source } });
    expect(await changes(base, head, moved("https://github.com/evil/lib .github/workflows/release.yml"))).toEqual([
      "lib@1.1.0 was built from https://github.com/evil/lib (.github/workflows/release.yml), but the version it replaces (1.0.0) from https://github.com/acme/lib (.github/workflows/release.yml)",
    ]);
    expect(await changes(base, head, moved("https://github.com/acme/lib .github/workflows/other.yml"))).toEqual([
      "lib@1.1.0 was built from https://github.com/acme/lib (.github/workflows/other.yml), but the version it replaces (1.0.0) from https://github.com/acme/lib (.github/workflows/release.yml)",
    ]);
    expect(await changes(base, head, moved(RELEASE))).toEqual([]);
  });

  it("fails a publisher, without provenance, who hadn't published up to the replaced version", async () => {
    expect(await changes(base, head, fake({ times, publishers: { "lib@1.1.0": "mallory" } }))).toEqual([
      "lib@1.1.0 has no provenance and its publisher mallory hadn't published any version up to the one it replaces",
    ]);
    // A release after the baseline doesn't make history.
    const primed = fake({
      times: { lib: { ...times.lib, "1.0.5": "2026-06-01T00:00:00Z" } },
      publishers: { "lib@1.0.5": "mallory", "lib@1.1.0": "mallory" },
    });
    expect(await changes(base, head, primed)).toEqual([
      "lib@1.1.0 has no provenance and its publisher mallory hadn't published any version up to the one it replaces",
    ]);
    expect(await changes(base, head, fake({ times }))).toEqual([]);
    // History is judged by valid publish times only: a malformed one fails rather than counting.
    const backdated: Fetch = async (url, init) => {
      const response = await primed(url, init);
      const body = (await response.json()) as { time: Record<string, string> };
      return respond({ ok: true, status: 200, body: { ...body, time: { ...body.time, "1.0.5": "2026" } } });
    };
    await expect(changes(base, head, backdated)).rejects.toThrow(/no valid publish time for lib@1.0.5/);
    // A package the change adds has no baseline to compare.
    const fresh = fake({ times: { fresh: { "1.0.0": "2026-01-01T00:00:00Z" } }, publishers: { "fresh@1.0.0": "mallory" } });
    expect(await changes([], pkgs({ fresh: "1.0.0" }), fresh)).toEqual([]);
  });

  it("checks gained provenance against the repository the replaced version declares", async () => {
    // Moving to trusted publishing from the declared repository: a new publisher, and fine.
    const trusted = fake({ times, publishers: { "lib@1.1.0": "GitHub Actions" }, sources: { "lib@1.1.0": RELEASE } });
    expect(await changes(base, head, trusted)).toEqual([]);
    const elsewhere = fake({ times, sources: { "lib@1.1.0": "https://github.com/evil/lib .github/workflows/release.yml" } });
    expect(await changes(base, head, elsewhere)).toEqual([
      "lib@1.1.0 was built from https://github.com/evil/lib (.github/workflows/release.yml), a repository the version it replaces (1.0.0) doesn't declare",
    ]);
  });

  it("takes the baseline only from copies shipped as their own registry tarball", async () => {
    const bundledLib = { version: "1.0.0", inBundle: true };
    const fetch = fake({
      times: { ...times, cdk: { "2.0.0": "2026-01-01T00:00:00Z", "2.1.0": "2026-09-01T00:00:00Z" } },
      sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": RELEASE },
    });
    // The bundled copy has no integrity of its own to bind provenance to; it isn't a baseline.
    const bundledOnly = pkgs({ cdk: "2.0.0" }, { "node_modules/cdk/node_modules/lib": bundledLib });
    expect(await changes(bundledOnly, pkgs({ cdk: "2.1.0", lib: "1.1.0" }), fetch)).toEqual([]);
    // Bundled and independent copies of the same version: the independent copy's integrity binds.
    const both = pkgs({ cdk: "2.0.0", lib: "1.0.0" }, { "node_modules/cdk/node_modules/lib": bundledLib });
    expect(await changes(both, pkgs({ cdk: "2.1.0", lib: "1.1.0" }), fetch)).toEqual([]);
  });

  it("binds every provenance statement to the exact package, version and locked digest", async () => {
    const attested = fake({ times, sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": RELEASE } });
    const forged = pkgs(
      {},
      {
        "node_modules/lib": {
          version: "1.1.0",
          resolved: "https://registry.npmjs.org/lib/-/lib-1.1.0.tgz",
          integrity: `sha512-${sha512("something else").toString("base64")}`,
        },
      },
    );
    await expect(changes(base, forged, attested)).rejects.toThrow(/doesn't describe lib@1.1.0 as locked/);
    const unlocked = pkgs({}, { "node_modules/lib": { version: "1.1.0", resolved: "https://registry.npmjs.org/lib/-/lib-1.1.0.tgz" } });
    await expect(changes(base, unlocked, attested)).rejects.toThrow(/no locked sha512/);
    // A statement served for another version can't stand in for this one.
    const swapped: Fetch = async (url, init) => attested(url.startsWith(ATTESTATIONS) ? url.replace("lib@1.1.0", "lib@1.0.0") : url, init);
    await expect(changes(base, head, swapped)).rejects.toThrow(/doesn't describe lib@1.1.0 as locked/);
  });

  it("passes a replaced version since unpublished, and a publish attestation that isn't provenance", async () => {
    expect(await changes(base, head, fake({ times: { lib: { "1.1.0": "2026-09-01T00:00:00Z" } } }))).toEqual([]);
    const publishOnly = registry({
      time: times.lib,
      versions: {
        "1.0.0": { _npmUser: { name: "m" }, dist: { attestations: { url: `${ATTESTATIONS}lib@1.0.0` } } },
        "1.1.0": { _npmUser: { name: "m" }, dist: {} },
      },
    });
    expect(await changes(base, head, publishOnly)).toEqual([]);
  });

  it("fails closed on manifests, attestations or provenance it can't read", async () => {
    const versions = (body: unknown) => registry({ time: times.lib, versions: body });
    const plain = { _npmUser: { name: "m" }, dist: {} };
    const attested = (attestations: unknown) => ({ _npmUser: { name: "m" }, dist: { attestations } });
    const run = (fetch: Fetch) => changes(base, head, fetch);
    await expect(run(versions({ "1.0.0": attested("yes"), "1.1.0": plain }))).rejects.toThrow(/malformed attestations for lib@1.0.0/);
    await expect(
      run(versions({ "1.0.0": attested({ url: `${ATTESTATIONS}x`, provenance: { predicateType: "https://example.com/p" } }), "1.1.0": plain })),
    ).rejects.toThrow(/malformed attestations/);
    await expect(
      run(versions({ "1.0.0": attested({ url: "https://evil.example/x", provenance: { predicateType: SLSA } }), "1.1.0": plain })),
    ).rejects.toThrow(/malformed attestations/);
    await expect(run(versions({ "1.0.0": plain }))).rejects.toThrow(/no valid manifest for lib@1.1.0/);
    await expect(run(versions({ "1.0.0": "x", "1.1.0": plain }))).rejects.toThrow(/no valid manifest for lib@1.0.0/);
    await expect(run(versions({ "1.0.0": plain, "1.1.0": { dist: {} } }))).rejects.toThrow(/names no publisher for lib@1.1.0/);
    await expect(run(fake({ times, sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": "" } }))).rejects.toThrow(/unrecognized provenance/);
  });
});

describe("config", () => {
  it("defaults everything and rejects unknown fields and malformed values", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(() => parseConfig({ npm: { lockfile: "x" } })).toThrow("npm has unknown field(s): lockfile");
    expect(() => parseConfig({ releaseAgeDays: -1 })).toThrow("nonnegative integer");
    expect(() => parseConfig({ ownPackages: { npm: { scopes: ["leanish"] } } })).toThrow("not an @scope");
    expect(() => parseConfig({ repositories: { "snappy-java": "xerial/snappy-java" } })).toThrow("isn't <ecosystem>:<package>");
    expect(parseConfig({ repositories: { "Maven:org.xerial.snappy:snappy-java": "xerial/snappy-java" } }).repositories).toEqual(
      new Map([["Maven|org.xerial.snappy:snappy-java", "xerial/snappy-java"]]),
    );
  });
});
