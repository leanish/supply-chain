import { describe, expect, it } from "vitest";

import { type Config, parseConfig } from "../src/config.ts";
import type { PackageName, PackageVersion } from "../src/package-version.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";
import { candidateVersions, gatherCandidates, type VersionCatalog, youngFixProblem } from "../src/young-fixes.ts";

const NOW = new Date("2026-10-06T12:00:00Z");
const DAY = 86_400_000;
const LIB: PackageName = { ecosystem: "npm", name: "lib" };

const advisory = (id: string, malicious = false): Advisory => ({ id, ids: [id], source: "osv", malicious, summary: undefined, severity: undefined });

/** Versions with their age in days and advisory ids (`MAL-…` ids are malware). */
type Registry = Record<string, { days: number; advisories?: string[] }>;

function catalog(registry: Registry): VersionCatalog {
  return {
    versions: async () => Object.keys(registry),
    published: async (pkg) => (registry[pkg.version] === undefined ? undefined : new Date(NOW.getTime() - registry[pkg.version]!.days * DAY)),
  };
}

async function verdict(registry: Registry, from: string, to: string, config: Config = parseConfig({}), pkg: PackageName = LIB) {
  const cat = catalog(registry);
  const young = { pkg: { ...pkg, version: to } as PackageVersion, replaced: [from] };
  const candidates = await gatherCandidates([young], { npm: cat, Maven: cat }, config);
  const map = new Map<string, Advisory[]>();
  for (const version of new Set([from, to, ...Object.keys(registry)])) {
    const ids = registry[version]?.advisories ?? [];
    map.set(`${pkg.ecosystem}|${pkg.name}|${version}`, ids.map((id) => advisory(id, id.startsWith("MAL-"))));
  }
  return youngFixProblem(young, candidates.byChange.get(`${pkg.ecosystem}|${pkg.name}|${to}`)!, new Snapshot(map, [], NOW), cat, config, NOW);
}

describe("young-fix proof", () => {
  const vulnerable = { days: 400, advisories: ["GHSA-a"] };

  it("takes the backport in the compatible line even when a mature major fixes too", async () => {
    const registry = { "1.9.4": vulnerable, "1.9.5": { days: 1 }, "2.0.0": { days: 90 } };
    expect(await verdict(registry, "1.9.4", "1.9.5")).toBeUndefined();
  });

  it("prefers an aged fix in the line over a lower young one", async () => {
    const registry = { "1.9.4": vulnerable, "1.9.5": { days: 1 }, "1.10.2": { days: 30 } };
    expect(await verdict(registry, "1.9.4", "1.9.5")).toBe("1.10.2 fixes GHSA-a too and is at least 7 days old (line 1)");
  });

  it("takes the lowest young fix when none is aged, and only that one", async () => {
    const registry = { "1.9.4": vulnerable, "1.9.5": { days: 2 }, "1.9.6": { days: 1 } };
    expect(await verdict(registry, "1.9.4", "1.9.5")).toBeUndefined();
    expect(await verdict(registry, "1.9.4", "1.9.6")).toBe("the lowest version fixing GHSA-a above 1.9.4 is 1.9.5 (line 1)");
  });

  it("lets a fix of A leave an inherited B", async () => {
    const registry = { "1.9.4": { days: 400, advisories: ["GHSA-a", "GHSA-b"] }, "1.9.5": { days: 1, advisories: ["GHSA-b"] } };
    expect(await verdict(registry, "1.9.4", "1.9.5")).toBeUndefined();
  });

  it("skips candidates that add an advisory or are malware", async () => {
    const registry = {
      "1.9.4": vulnerable,
      "1.9.5": { days: 3, advisories: ["GHSA-new"] },
      "1.9.6": { days: 2, advisories: ["MAL-2026-1"] },
      "1.9.7": { days: 1 },
    };
    expect(await verdict(registry, "1.9.4", "1.9.7")).toBeUndefined();
  });

  it("takes the lowest major that fixes when the line has none", async () => {
    const registry = { "1.9.4": vulnerable, "1.9.5": { days: 30, advisories: ["GHSA-a"] }, "2.0.0": { days: 1 }, "3.0.0": { days: 1 } };
    expect(await verdict(registry, "1.9.4", "2.0.0")).toBeUndefined();
    expect(await verdict(registry, "1.9.4", "3.0.0")).toBe("the lowest version fixing GHSA-a above 1.9.4 is 2.0.0 (line 2)");
  });

  it("fails once an older fix in the line matures, so CI asks for the safer one", async () => {
    const registry = { "1.9.4": vulnerable, "1.9.5": { days: 2 }, "1.9.6": { days: 7 } };
    expect(await verdict(registry, "1.9.4", "1.9.5")).toBe("1.9.6 fixes GHSA-a too and is at least 7 days old (line 1)");
  });

  it("needs a target: a young version that fixes nothing, or only malware, isn't a security fix", async () => {
    expect(await verdict({ "1.9.4": { days: 400 }, "1.9.5": { days: 1 } }, "1.9.4", "1.9.5")).toBe("it fixes no advisory affecting 1.9.4");
    expect(await verdict({ "1.9.4": { days: 400, advisories: ["MAL-2026-2"] }, "1.9.5": { days: 1 } }, "1.9.4", "1.9.5")).toBe(
      "it fixes no advisory affecting 1.9.4",
    );
  });

  it("uses configured compatible lines", async () => {
    const boot: PackageName = { ecosystem: "Maven", name: "org.springframework.boot:spring-boot" };
    const registry = { "3.4.1": vulnerable, "3.4.2": { days: 1 }, "3.5.0": { days: 30 } };
    expect(await verdict(registry, "3.4.1", "3.4.2", parseConfig({}), boot)).toBe("3.5.0 fixes GHSA-a too and is at least 7 days old (line 3)");
    const config = parseConfig({ compatibleLines: { "Maven:org.springframework.boot:*": 2 } });
    expect(await verdict(registry, "3.4.1", "3.4.2", config, boot)).toBeUndefined();
  });
});

describe("candidate versions", () => {
  it("takes versions above the replaced one up to the end of the new one's line, without prereleases", () => {
    const all = ["1.9.3", "1.9.4", "1.9.5", "1.10.0-rc.1", "1.10.0", "2.0.0", "2.0.1", "2.1.0", "3.0.0", "not-a-version"];
    expect(candidateVersions(parseConfig({}), LIB, "1.9.4", "1.9.5", all)).toEqual(["1.9.5", "1.10.0"]);
    expect(candidateVersions(parseConfig({}), LIB, "1.9.4", "2.0.0", all)).toEqual(["1.9.5", "1.10.0", "2.0.0", "2.0.1", "2.1.0"]);
    expect(candidateVersions(parseConfig({}), LIB, "1.10.0-rc.0", "1.10.0", all)).toEqual(["1.10.0-rc.1", "1.10.0"]);
  });

  it("keeps the replaced version's Maven flavor", () => {
    const guava: PackageName = { ecosystem: "Maven", name: "com.google.guava:guava" };
    const all = ["33.7.1-jre", "33.7.1-android", "33.7.2-jre", "33.7.2-android", "33.8.0-jre"];
    expect(candidateVersions(parseConfig({}), guava, "33.7.1-jre", "33.7.2-jre", all)).toEqual(["33.7.2-jre", "33.8.0-jre"]);
  });
});
