import { describe, expect, it } from "vitest";

import { type CarrierSearch, type CarrierServices, chooseCarrier, type CompleteBundle, removedTargets } from "../src/carrier-fixes.ts";
import { parseConfig } from "../src/config.ts";
import type { BundleContents } from "../src/npm-bundles.ts";
import { type PackageVersion, versionKey } from "../src/package-version.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const DAY = 86_400_000;

const advisory = (id: string): Advisory => ({ id, ids: [id], source: "osv", malicious: id.startsWith("MAL-"), summary: undefined, severity: undefined });

/** `name@version` → advisory ids, for every version any test reads. */
const ADVISORIES: Record<string, string[]> = {
  "brace@5.0.9": ["GHSA-brace"],
  "brace@4.0.0": ["GHSA-brace"],
  "glob@1.0.0": ["GHSA-glob"],
  "evil@1.0.0": ["MAL-evil"],
  "cdk@2.9.0": ["GHSA-cdk-own"],
  "cdk@2.12.0": ["GHSA-cdk-new"],
};

function bundle(...packages: string[]): CompleteBundle {
  return {
    complete: true,
    packages: packages.map((label) => {
      const [path, pkg] = label.includes("=") ? label.split("=") as [string, string] : [`node_modules/${label.slice(0, label.lastIndexOf("@"))}`, label];
      const at = pkg.lastIndexOf("@");
      return {
        path, installedAs: path.slice(path.lastIndexOf("node_modules/") + 13), name: pkg.slice(0, at), version: pkg.slice(at + 1),
        dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {},
      };
    }),
  };
}

interface Release {
  readonly days?: number;
  readonly bundle: BundleContents;
}

function setup(releases: Record<string, Release>) {
  const reads: string[] = [];
  const scans: number[] = [];
  const services: CarrierServices = {
    bundles: async (version) => {
      reads.push(version);
      const release = releases[version];
      if (release === undefined) throw new Error(`no release ${version}`);
      return release.bundle;
    },
    scan: async (packages: ReadonlyArray<PackageVersion>) => {
      scans.push(packages.length);
      const map = new Map<string, Advisory[]>();
      for (const pkg of packages) map.set(versionKey(pkg), (ADVISORIES[`${pkg.name}@${pkg.version}`] ?? []).map(advisory));
      return new Snapshot(map, [], NOW);
    },
    catalog: {
      versions: async () => Object.keys(releases),
      published: async (pkg) => {
        const days = releases[pkg.version]?.days;
        return days === undefined ? undefined : new Date(NOW.getTime() - days * DAY);
      },
    },
    config: parseConfig({}),
    now: NOW,
  };
  return { services, reads, scans };
}

const FROM = bundle("brace@5.0.9", "minimatch@10.2.5");

function search(versions: string[], overrides: Partial<CarrierSearch> = {}): CarrierSearch {
  return {
    carrier: "cdk", from: "2.9.0", fromBundle: FROM, carried: [{ name: "brace", advisory: "GHSA-brace" }], own: [],
    malicious: false, versions, ownPackage: false, ...overrides,
  };
}

const fixed = bundle("brace@5.0.12", "minimatch@10.2.5");

describe("choosing a carrier version", () => {
  it("takes the lowest aged version whose bundle drops the target", async () => {
    const { services, reads } = setup({ "2.10.0": { days: 30, bundle: FROM }, "2.11.0": { days: 20, bundle: fixed }, "2.12.0": { days: 10, bundle: fixed } });
    expect(await chooseCarrier(search(["2.10.0", "2.11.0", "2.12.0"]), services)).toMatchObject({ kind: "chosen", version: "2.11.0", aged: true, line: "2" });
    expect(reads).toEqual(["2.10.0", "2.11.0", "2.12.0"]);
  });

  it("prefers a later aged fix in the line over a lower young one, reading no young bundle after the first fix", async () => {
    const { services, reads } = setup({ "2.10.0": { days: 1, bundle: fixed }, "2.10.1": { days: 0, bundle: fixed }, "2.11.0": { days: 30, bundle: fixed } });
    expect(await chooseCarrier(search(["2.10.0", "2.10.1", "2.11.0"]), services)).toMatchObject({ kind: "chosen", version: "2.11.0", aged: true });
    expect(reads.filter((version) => version === "2.10.1").length).toBeLessThanOrEqual(1);
  });

  it("takes the lowest young fix when no fix in its line is aged", async () => {
    const { services } = setup({ "2.10.0": { days: 2, bundle: fixed }, "2.11.0": { days: 1, bundle: fixed } });
    expect(await chooseCarrier(search(["2.10.0", "2.11.0"]), services)).toMatchObject({ kind: "chosen", version: "2.10.0", aged: false });
  });

  it("stays in the first line with a fix: a later major isn't read", async () => {
    const { services, reads } = setup({ "2.10.0": { days: 2, bundle: fixed }, "3.0.0": { days: 300, bundle: fixed } });
    expect(await chooseCarrier(search(["2.10.0", "3.0.0"]), services)).toMatchObject({ version: "2.10.0", aged: false });
    expect(reads).not.toContain("3.0.0");
  });

  it("crosses into the next line only when its own has no fix", async () => {
    const { services } = setup({ "2.10.0": { days: 30, bundle: FROM }, "3.0.0": { days: 300, bundle: fixed } });
    expect(await chooseCarrier(search(["2.10.0", "3.0.0"]), services)).toMatchObject({ version: "3.0.0", line: "3", aged: true });
  });

  it("finds the vulnerable package wherever the bundle moved it", async () => {
    const moved = bundle("node_modules/minimatch/node_modules/brace=brace@5.0.9", "minimatch@10.2.5");
    const { services } = setup({ "2.10.0": { days: 30, bundle: moved } });
    expect(await chooseCarrier(search(["2.10.0"]), services)).toMatchObject({ kind: "none" });
  });

  it("accepts a bundle that drops the vulnerable package altogether", async () => {
    const { services } = setup({ "2.10.0": { days: 30, bundle: bundle("minimatch@10.2.5") } });
    expect(await chooseCarrier(search(["2.10.0"]), services)).toMatchObject({ version: "2.10.0" });
  });

  it.each([
    ["adds another vulnerable package", bundle("brace@5.0.12", "glob@1.0.0")],
    ["ships malware", bundle("brace@5.0.12", "evil@1.0.0")],
    ["keeps the advisory in a second copy", bundle("brace@5.0.12", "node_modules/x/node_modules/brace=brace@4.0.0")],
  ])("rejects a bundle that %s", async (_, candidate) => {
    const { services } = setup({ "2.10.0": { days: 30, bundle: candidate } });
    expect(await chooseCarrier(search(["2.10.0"]), services)).toMatchObject({ kind: "none" });
  });

  it("rejects a carrier version with an advisory of its own the old one lacked", async () => {
    const { services } = setup({ "2.12.0": { days: 30, bundle: fixed }, "2.13.0": { days: 20, bundle: fixed } });
    expect(await chooseCarrier(search(["2.12.0", "2.13.0"]), services)).toMatchObject({ version: "2.13.0" });
  });

  it("makes every candidate fix the carrier's own targets too", async () => {
    const { services } = setup({ "2.10.0": { days: 30, bundle: fixed } });
    ADVISORIES["cdk@2.10.0"] = ["GHSA-cdk-own"];
    try {
      expect(await chooseCarrier(search(["2.10.0"], { own: ["GHSA-cdk-own"] }), services)).toMatchObject({ kind: "none" });
    } finally {
      delete ADVISORIES["cdk@2.10.0"];
    }
  });

  it("ends the search as incomplete on an unreadable bundle before any fix", async () => {
    const { services } = setup({ "2.10.0": { days: 30, bundle: { complete: false, reason: "budget" } }, "2.11.0": { days: 30, bundle: fixed } });
    expect(await chooseCarrier(search(["2.10.0", "2.11.0"]), services)).toEqual({ kind: "incomplete", reason: "cdk@2.10.0's bundle can't be read: budget" });
  });

  it("ends the search as incomplete when a fix's publish time is unknown", async () => {
    const { services } = setup({ "2.10.0": { bundle: fixed } });
    expect(await chooseCarrier(search(["2.10.0"]), services)).toMatchObject({ kind: "incomplete" });
  });

  it("lets own packages take the lowest fix whatever its age", async () => {
    const { services } = setup({ "2.10.0": { days: 0, bundle: fixed }, "2.11.0": { days: 30, bundle: fixed } });
    expect(await chooseCarrier(search(["2.10.0", "2.11.0"], { ownPackage: true }), services)).toMatchObject({ version: "2.10.0", aged: false });
  });

  it("judges on one snapshot covering every bundle read so far", async () => {
    const { services, scans } = setup({ "2.10.0": { days: 30, bundle: FROM }, "2.11.0": { days: 30, bundle: FROM }, "2.12.0": { days: 30, bundle: FROM }, "2.13.0": { days: 30, bundle: FROM }, "2.14.0": { days: 30, bundle: fixed } });
    await chooseCarrier(search(["2.10.0", "2.11.0", "2.12.0", "2.13.0", "2.14.0"]), services);
    expect(scans).toHaveLength(2);
    expect(scans[1]!).toBeGreaterThan(scans[0]!);
  });

  describe("leaving malware", () => {
    const malicious = bundle("evil@1.0.0");
    const clean = bundle("minimatch@10.2.5");
    const malwareSearch = (versions: string[]) => search(versions, { from: "2.9.0", fromBundle: malicious, carried: [], malicious: true });

    it("takes the nearest clean aged version newer in its line", async () => {
      const { services } = setup({ "2.8.0": { days: 90, bundle: clean }, "2.10.0": { days: 1, bundle: clean }, "2.11.0": { days: 30, bundle: clean } });
      expect(await chooseCarrier(malwareSearch(["2.8.0", "2.10.0", "2.11.0"]), services)).toMatchObject({ version: "2.11.0", aged: true });
    });

    it("then an older clean version in its line", async () => {
      const { services } = setup({ "2.7.0": { days: 200, bundle: clean }, "2.8.0": { days: 90, bundle: clean }, "2.10.0": { days: 1, bundle: clean } });
      expect(await chooseCarrier(malwareSearch(["2.7.0", "2.8.0", "2.10.0"]), services)).toMatchObject({ version: "2.8.0" });
    });

    it("never takes a young version", async () => {
      const { services } = setup({ "2.10.0": { days: 1, bundle: clean } });
      expect(await chooseCarrier(malwareSearch(["2.10.0"]), services)).toMatchObject({ kind: "none" });
    });
  });
});

describe("what a bundle change removes", () => {
  it("lists each package and advisory group the old bundle has and the new one doesn't", async () => {
    const { services } = setup({});
    const snapshot = await services.scan([
      { ecosystem: "npm", name: "brace", version: "5.0.9" }, { ecosystem: "npm", name: "glob", version: "1.0.0" },
      { ecosystem: "npm", name: "brace", version: "5.0.12" }, { ecosystem: "npm", name: "evil", version: "1.0.0" },
    ]);
    expect(removedTargets(bundle("brace@5.0.9", "glob@1.0.0", "evil@1.0.0"), bundle("brace@5.0.12", "glob@1.0.0"), snapshot)).toEqual([
      { name: "brace", advisory: "GHSA-brace" },
    ]);
  });
});
