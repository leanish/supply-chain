import { describe, expect, it } from "vitest";

import { type CarrierGroup, decideCarrier, splitBundled } from "../src/carrier-candidates.ts";
import { NpmCatalog } from "../src/catalogs.ts";
import { parseConfig } from "../src/config.ts";
import type { Finding } from "../src/findings.ts";
import type { NpmLockfile } from "../src/inventory.ts";
import { BundleReader } from "../src/npm-bundles.ts";
import { lockedPackages } from "../src/npm-lock.ts";
import { NpmRegistry } from "../src/npm-registry.ts";
import { type PackageVersion, versionKey } from "../src/package-version.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";
import { fakeFetch } from "./fake-fetch.ts";
import { archive, manifest, serving } from "./tarballs.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const OLD = "2026-01-01T00:00:00Z";
const tarball = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

function carrierArchive(name: string, version: string, bundles: ReadonlyArray<string>) {
  return archive([
    { path: "package/package.json", body: manifest(name, version) },
    ...bundles.map((label) => {
      const [bundled, at] = [label.slice(0, label.lastIndexOf("@")), label.slice(label.lastIndexOf("@") + 1)];
      return { path: `package/node_modules/${bundled}/package.json`, body: manifest(bundled, at) };
    }),
  ]);
}

function lockfile(path: string, entries: Record<string, object>): NpmLockfile {
  return { path, packages: lockedPackages({ lockfileVersion: 3, packages: { "": { name: "app" }, ...entries } }), bundleProblems: [] };
}

function finding(name: string, version: string, advisory: string, locations: string[], extra: Partial<Finding> = {}): Finding {
  return { ecosystem: "npm", name, version, advisory, ids: [advisory], malicious: false, summary: undefined, severity: "HIGH", locations, ...extra };
}

describe("splitting bundled findings off to their carriers", () => {
  const app = lockfile("package-lock.json", {
    "node_modules/carrier": { version: "1.0.0", resolved: tarball("carrier", "1.0.0"), integrity: "sha512-A" },
    "node_modules/carrier/node_modules/brace": { version: "5.0.9", inBundle: true },
    "node_modules/carrier/node_modules/minimatch": { version: "10.2.5", inBundle: true },
    "node_modules/carrier/node_modules/minimatch/node_modules/brace": { version: "5.0.9", inBundle: true },
    "node_modules/brace": { version: "5.0.9", resolved: tarball("brace", "5.0.9"), integrity: "sha512-B" },
  });
  const infra = lockfile("infra/package-lock.json", {
    "node_modules/carrier": { version: "1.0.0", resolved: tarball("carrier", "1.0.0"), integrity: "sha512-A" },
    "node_modules/carrier/node_modules/brace": { version: "5.0.9", inBundle: true },
  });

  it("keeps unbundled copies for an ordinary fix and groups bundled ones by carrier version, nested bundles included", () => {
    const { rest, carriers } = splitBundled([
      finding("brace", "5.0.9", "GHSA-brace", [
        "node_modules/brace", "node_modules/carrier/node_modules/brace", "node_modules/carrier/node_modules/minimatch/node_modules/brace", "infra/node_modules/carrier/node_modules/brace",
      ]),
    ], [app, infra]);
    expect(rest).toEqual([expect.objectContaining({ name: "brace", locations: ["node_modules/brace"] })]);
    expect(carriers).toHaveLength(1);
    const [group] = carriers as [CarrierGroup];
    expect(group).toMatchObject({ name: "carrier", version: "1.0.0", malicious: false });
    expect(group.copies.map(({ lockfile: lock, copy }) => `${lock.path}:${copy.path}`)).toEqual(["package-lock.json:node_modules/carrier", "infra/package-lock.json:node_modules/carrier"]);
    expect([...group.carried.get("brace")!.locations]).toHaveLength(3);
  });

  it("leaves Gradle and Actions findings alone", () => {
    const maven = { ...finding("org:lib", "1.0", "GHSA-x", [":runtimeClasspath"]), ecosystem: "Maven" as const };
    expect(splitBundled([maven], [app])).toEqual({ rest: [maven], carriers: [] });
  });
});

describe("deciding a carrier move", () => {
  const releases: Record<string, { published: string; bundles: string[] }> = {
    "1.0.0": { published: OLD, bundles: ["brace@5.0.9"] },
    "1.1.0": { published: "2026-09-01T00:00:00Z", bundles: ["brace@5.0.12"] },
  };
  const archives = Object.fromEntries(Object.entries(releases).map(([version, release]) => [version, carrierArchive("carrier", version, release.bundles)]));
  const registry = new NpmRegistry(fakeFetch({
    "https://registry.npmjs.org/carrier": { body: {
      time: Object.fromEntries(Object.entries(releases).map(([version, release]) => [version, release.published])),
      versions: Object.fromEntries(Object.keys(releases).map((version) => [version, { dist: { integrity: archives[version]!.integrity } }])),
    } },
  }));
  const context = (identity: string[] = []) => ({
    reader: new BundleReader(serving(Object.fromEntries(Object.entries(archives).map(([version, { bytes }]) => [tarball("carrier", version), bytes])))),
    registry, catalog: new NpmCatalog(registry), config: parseConfig({}), now: NOW,
    scan: async (packages: ReadonlyArray<PackageVersion>) => new Snapshot(new Map(packages.map((pkg) => [versionKey(pkg),
      (pkg.name === "brace" && pkg.version === "5.0.9" ? ["GHSA-brace"] : []).map((id): Advisory => ({ id, ids: [id], source: "osv", malicious: false, summary: undefined, severity: undefined }))])), [], NOW),
    identity: async () => identity,
  });
  const group = (lockedBundle: string): CarrierGroup => {
    const { carriers } = splitBundled([finding("brace", "5.0.9", "GHSA-brace", ["node_modules/carrier/node_modules/brace"])], [lockfile("package-lock.json", {
      "node_modules/carrier": { version: "1.0.0", resolved: tarball("carrier", "1.0.0"), integrity: archives["1.0.0"]!.integrity },
      "node_modules/carrier/node_modules/brace": { version: lockedBundle, inBundle: true },
    })]);
    return carriers[0]!;
  };

  it("picks the carrier version whose bundle drops the target, and says what it ships", async () => {
    expect(await decideCarrier(group("5.0.9"), [], false, context(["an identity break"]))).toEqual({
      from: "1.0.0",
      locations: ["node_modules/carrier"],
      carries: [{ name: "brace", from: ["5.0.9"], locations: ["node_modules/carrier/node_modules/brace"], advisories: ["GHSA-brace"], to: ["5.0.12"] }],
      to: { version: "1.1.0", line: "1", aged: true, major: false, blockers: ["an identity break"] },
      problem: undefined,
    });
  });

  it("refuses a lockfile whose bundle isn't what the archive ships", async () => {
    const decision = await decideCarrier(group("5.0.8"), [], false, context());
    expect(decision).toMatchObject({ to: undefined, problem: expect.stringContaining("the lockfile records brace@5.0.8") });
  });
});
