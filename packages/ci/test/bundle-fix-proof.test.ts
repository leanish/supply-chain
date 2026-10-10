import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type GateEnvironment, runCompare } from "../src/gate.ts";
import { runProcess, type RunProcess } from "../src/process.ts";
import { gitTree } from "../src/tree.ts";
import { fakeFetch } from "./fake-fetch.ts";
import { archive, manifest, serving, type TarEntry } from "./tarballs.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const OLD = "2026-01-01T00:00:00Z";
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** A carrier release: its age and what its archive bundles (`name@version`, under `node_modules/`). */
interface Release {
  readonly published: string;
  readonly bundles: ReadonlyArray<string>;
}

function carrierArchive(version: string, bundles: ReadonlyArray<string>) {
  const entries: TarEntry[] = [{ path: "package/package.json", body: manifest("carrier", version, { bundleDependencies: bundles.map(nameOf) }) }];
  for (const label of bundles) entries.push({ path: `package/node_modules/${nameOf(label)}/package.json`, body: manifest(nameOf(label), versionOf(label)) });
  return archive(entries);
}

const nameOf = (label: string) => label.slice(0, label.lastIndexOf("@"));
const versionOf = (label: string) => label.slice(label.lastIndexOf("@") + 1);
const tarball = (version: string) => `https://registry.npmjs.org/carrier/-/carrier-${version}.tgz`;

let repo: string;
const git = (...args: string[]) =>
  runProcess("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd: repo }).then((result) => {
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  });

async function commit(files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "change");
  return git("rev-parse", "HEAD");
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "supply-chain-bundle-fix-"));
  await git("init", "-q", "-b", "main");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** A carrier copy at `at`: its version, locked integrity and recorded bundle. */
interface Copy {
  readonly at: string;
  readonly version: string;
  readonly integrity: string;
  readonly bundles: ReadonlyArray<string>;
}

/** A lockfile with these carrier copies, each recording its bundle as bundled entries. */
function lock(copies: ReadonlyArray<Copy>): string {
  const packages: Record<string, object> = { "": { name: "app", dependencies: { carrier: `^${copies[0]!.version}` } } };
  for (const { at, version, integrity, bundles } of copies) {
    const holder = at.includes("/node_modules/carrier") ? at.slice("node_modules/".length, at.lastIndexOf("/node_modules/")) : undefined;
    if (holder !== undefined) packages[`node_modules/${holder}`] = { version: "1.0.0", resolved: `https://registry.npmjs.org/${holder}/-/${holder}-1.0.0.tgz`, integrity: "sha512-AAAA" };
    packages[at] = { version, resolved: tarball(version), integrity, bundleDependencies: bundles.map(nameOf), dependencies: Object.fromEntries(bundles.map((label) => [nameOf(label), versionOf(label)])) };
    for (const label of bundles) packages[`${at}/node_modules/${nameOf(label)}`] = { version: versionOf(label), inBundle: true };
  }
  return JSON.stringify({ lockfileVersion: 3, packages });
}

function environment(releases: Record<string, Release>, affected: Record<string, string[]>, integrityOverride: Record<string, string> = {}): { env: GateEnvironment; integrity: (version: string) => string } {
  const archives = Object.fromEntries(Object.entries(releases).map(([version, release]) => [version, carrierArchive(version, release.bundles)]));
  const integrity = (version: string) => integrityOverride[version] ?? archives[version]!.integrity;
  const run: RunProcess = async (command, args, options) => {
    if (command !== "osv-scanner") return runProcess(command, args, options);
    if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
    const inventory = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
      results: Array<{ packages: Array<{ package: { name: string; version: string; ecosystem: string } }> }>;
    };
    const packages = inventory.results[0]!.packages.map(({ package: pkg }) => ({
      package: pkg,
      vulnerabilities: (affected[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id, summary: `${id} summary` })),
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
  const versions = Object.fromEntries(Object.keys(releases).map((version) => [version, { _npmUser: { name: "maintainer" }, dist: { integrity: archives[version]!.integrity, tarball: tarball(version) } }]));
  // Source repository lookups: none declared.
  const perVersion = Object.fromEntries([
    ...Object.keys(releases).map((version) => `carrier/${version}`),
    ...[...VULNERABLE, ...FIXED].map((label) => `${nameOf(label)}/${versionOf(label)}`),
    "holder/1.0.0",
    "other/1.0.0",
  ].map((path) => [`https://registry.npmjs.org/${path}`, { body: {} }]));
  const fetch = fakeFetch({
    ...perVersion,
    ...Object.fromEntries(["holder", "other"].map((holder) => [`https://registry.npmjs.org/${holder}`, { body: { time: { "1.0.0": OLD }, versions: { "1.0.0": { _npmUser: { name: "maintainer" }, dist: {} } } } }])),
    "https://registry.npmjs.org/carrier": { body: { time: Object.fromEntries(Object.entries(releases).map(([version, release]) => [version, release.published])), versions } },
  });
  const fetchArchive = serving(Object.fromEntries(Object.entries(archives).map(([version, { bytes }]) => [tarball(version), bytes])));
  return { env: { run, fetch, fetchArchive, now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined }, integrity };
}

interface CompareOptions {
  readonly affected?: Record<string, string[]>;
  readonly headBundles?: string[];
  readonly headIntegrity?: string;
  /** A second carrier copy, nested under `holder`, replaced too: with these recorded bundles in head. */
  readonly nested?: ReadonlyArray<string>;
  /** A copy of the young version head adds where base had none. */
  readonly unrelated?: boolean;
  readonly scan?: (env: GateEnvironment) => GateEnvironment;
}

async function compare(releases: Record<string, Release>, from: string, to: string, options: CompareOptions = {}) {
  const affected = options.affected ?? { "brace@5.0.9": ["GHSA-brace"] };
  const { env, integrity } = environment(releases, affected, options.headIntegrity === undefined ? {} : { [to]: options.headIntegrity });
  const nested = "node_modules/holder/node_modules/carrier";
  const baseCopies: Copy[] = [{ at: "node_modules/carrier", version: from, integrity: integrity(from), bundles: releases[from]!.bundles }];
  const headCopies: Copy[] = [{ at: "node_modules/carrier", version: to, integrity: integrity(to), bundles: options.headBundles ?? releases[to]!.bundles }];
  if (options.nested !== undefined) {
    baseCopies.push({ at: nested, version: from, integrity: integrity(from), bundles: releases[from]!.bundles });
    headCopies.push({ at: nested, version: to, integrity: integrity(to), bundles: options.nested });
  }
  if (options.unrelated === true) headCopies.push({ at: "node_modules/other/node_modules/carrier", version: to, integrity: integrity(to), bundles: releases[to]!.bundles });
  const base = await commit({ "package-lock.json": lock(baseCopies) });
  const head = await commit({ "package-lock.json": lock(headCopies) });
  return runCompare(await gitTree(repo, base, runProcess), await gitTree(repo, head, runProcess), (options.scan ?? ((given) => given))(env));
}

const VULNERABLE = ["brace@5.0.9", "minimatch@10.2.5"];
const FIXED = ["brace@5.0.12", "minimatch@10.2.5"];
const ageFailures = (failures: ReadonlyArray<string>) => failures.filter((failure) => failure.startsWith("carrier@"));

describe("a young carrier proved as a bundled fix", () => {
  it("is justified when it's the version the rule picks for what its bundle drops", async () => {
    const outcome = await compare({ "1.0.0": { published: OLD, bundles: VULNERABLE }, "1.1.0": { published: daysAgo(1), bundles: FIXED } }, "1.0.0", "1.1.0");
    expect(ageFailures(outcome.failures)).toEqual([]);
    expect(outcome.cooldown).toMatchObject({ evaluated: true, held: [expect.objectContaining({ name: "carrier", version: "1.1.0", justification: "bundle-fix" })] });
  });

  it("isn't when an aged version's bundle drops it too", async () => {
    const outcome = await compare({
      "1.0.0": { published: OLD, bundles: VULNERABLE }, "1.0.5": { published: daysAgo(30), bundles: FIXED }, "1.1.0": { published: daysAgo(1), bundles: FIXED },
    }, "1.0.0", "1.1.0");
    expect(ageFailures(outcome.failures)).toEqual([expect.stringContaining("1.0.5 ships a bundle without brace GHSA-brace too and is at least 7 days old")]);
  });

  it("isn't when its bundle drops nothing", async () => {
    const outcome = await compare({ "1.0.0": { published: OLD, bundles: VULNERABLE }, "1.1.0": { published: daysAgo(1), bundles: VULNERABLE } }, "1.0.0", "1.1.0");
    expect(ageFailures(outcome.failures)).toEqual([expect.stringContaining("fixes nothing 1.0.0's had")]);
  });

  it("isn't when head's lockfile records a bundle its archive doesn't ship", async () => {
    const outcome = await compare({ "1.0.0": { published: OLD, bundles: VULNERABLE }, "1.1.0": { published: daysAgo(1), bundles: VULNERABLE } }, "1.0.0", "1.1.0", { headBundles: FIXED });
    expect(ageFailures(outcome.failures)).toEqual([expect.stringContaining("node_modules/carrier ships brace@5.0.9 at node_modules/brace, but the lockfile records brace@5.0.12")]);
  });

  const TWO = { "1.0.0": { published: OLD, bundles: VULNERABLE }, "1.1.0": { published: daysAgo(1), bundles: FIXED } };

  it("is when every copy it replaces in place is proved", async () => {
    const outcome = await compare(TWO, "1.0.0", "1.1.0", { nested: FIXED });
    expect(ageFailures(outcome.failures)).toEqual([]);
  });

  it("isn't when one of the copies it replaces records another bundle than its archive", async () => {
    const outcome = await compare(TWO, "1.0.0", "1.1.0", { nested: VULNERABLE });
    expect(ageFailures(outcome.failures)).toEqual([expect.stringContaining("node_modules/holder/node_modules/carrier ships brace@5.0.12 at node_modules/brace, but the lockfile records brace@5.0.9")]);
  });

  it("isn't when head also has it where it replaces no carrier", async () => {
    const outcome = await compare(TWO, "1.0.0", "1.1.0", { unrelated: true });
    expect(ageFailures(outcome.failures)).toEqual([expect.stringContaining("is also where it replaces no carrier copy in place")]);
  });

  it("leaves it unjustified, without failing the comparison, when the proof's own scan fails", async () => {
    let scans = 0;
    const outcome = await compare(TWO, "1.0.0", "1.1.0", { scan: (env) => ({ ...env, run: async (command, args, options) => {
      if (command === "osv-scanner" && args[0] !== "--version" && ++scans > 1) throw new Error("scanner crashed");
      return env.run(command, args, options);
    } }) });
    expect(ageFailures(outcome.failures)).toEqual([expect.stringContaining("the bundle-fix justification could not be established")]);
  });

  it("proves the version that fixes the carrier's own advisory and its bundle's together", async () => {
    const outcome = await compare({
      "1.0.0": { published: OLD, bundles: VULNERABLE },
      "1.0.5": { published: daysAgo(30), bundles: VULNERABLE },
      "1.1.0": { published: daysAgo(20), bundles: FIXED },
      "1.2.0": { published: daysAgo(1), bundles: FIXED },
    }, "1.0.0", "1.2.0", { affected: { "brace@5.0.9": ["GHSA-brace"], "carrier@1.0.0": ["GHSA-own"], "carrier@1.1.0": ["GHSA-own"] } });
    expect(ageFailures(outcome.failures)).toEqual([]);
    expect(outcome.cooldown).toMatchObject({ held: [expect.objectContaining({ version: "1.2.0", justification: "bundle-fix" })] });
  });

  it("isn't when head locks another archive than the registry's", async () => {
    const other = archive([{ path: "package/package.json", body: manifest("carrier", "1.1.0") }]).integrity;
    const outcome = await compare({ "1.0.0": { published: OLD, bundles: VULNERABLE }, "1.1.0": { published: daysAgo(1), bundles: FIXED } }, "1.0.0", "1.1.0", { headIntegrity: other });
    expect(ageFailures(outcome.failures)).toEqual([expect.stringContaining("isn't the registry's archive")]);
  });
});
