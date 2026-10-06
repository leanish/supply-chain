import { describe, expect, it } from "vitest";

import { checkFloors, parseFloors } from "../src/floors.ts";
import { compareGradleVersions } from "../src/gradle-versions.ts";
import type { GradleConfiguration, GradleInventory } from "../src/gradle.ts";
import type { Inventory } from "../src/inventory.ts";
import { lockedPackages } from "../src/npm-lock.ts";
import type { Tree } from "../src/tree.ts";

function expectAscending(versions: string[]): void {
  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      expect(compareGradleVersions(versions[i]!, versions[j]!), `${versions[i]} < ${versions[j]}`).toBeLessThan(0);
      expect(compareGradleVersions(versions[j]!, versions[i]!), `${versions[j]} > ${versions[i]}`).toBeGreaterThan(0);
    }
  }
}

describe("Gradle version ordering", () => {
  // The examples in Gradle's "Version ordering" documentation.
  it("orders parts the way Gradle does", () => {
    expectAscending(["1.1", "1.2"]);
    expectAscending(["1.a", "1.1"]);
    expectAscending(["1.A", "1.B", "1.a", "1.b"]);
    expectAscending(["1.1", "1.1.0"]);
    expectAscending(["1.1.a", "1.1"]);
    expectAscending(["1.0-dev", "1.0-ALPHA", "1.0-alpha", "1.0-rc"]);
    expectAscending(["1.0-zeta", "1.0-rc", "1.0-snapshot", "1.0-final", "1.0-ga", "1.0-release", "1.0-sp", "1.0"]);
    expect(compareGradleVersions("1.0-RC-1", "1.0.rc.1")).toBe(0);
    expect(compareGradleVersions("1a1", "1.a.1")).toBe(0);
  });

  it("differs from Maven where it matters for floors", () => {
    // Maven puts 33.7.2-jre after 33.7.2; Gradle puts it before.
    expect(compareGradleVersions("33.7.2-jre", "33.7.2")).toBeLessThan(0);
    expect(compareGradleVersions("33.7.2-jre", "33.7.1-jre")).toBeGreaterThan(0);
    expect(compareGradleVersions("1.1.10.10", "1.1.10.9")).toBeGreaterThan(0);
  });
});

const guavaFloor = {
  ecosystem: "Maven",
  package: "com.google.guava:guava",
  version: "33.7.2-jre",
  declaredIn: "build.gradle.kts",
  selector: [":checkstyle"],
  purpose: "security",
  advisories: ["CVE-2026-102554"],
  reason: "Checkstyle pulls an affected Guava",
  added: "2026-10-04",
};

describe("floors file", () => {
  it("reads entries and normalizes selectors: Gradle locations, npm key paths", () => {
    const [floor] = parseFloors({ floors: [{ ...guavaFloor, selector: ":checkstyle" }] });
    expect(floor!.locations).toEqual([":checkstyle"]);
    const npm = { ...guavaFloor, ecosystem: "npm", package: "child", version: "2.0.0", declaredIn: "package.json" };
    expect(parseFloors({ floors: [{ ...npm, selector: "child" }] })[0]!.overridePaths).toEqual([["child"]]);
    expect(parseFloors({ floors: [{ ...npm, selector: [["parent@>=2.0.0", "child"], "child"] }] })[0]!.overridePaths).toEqual([
      ["parent@>=2.0.0", "child"],
      ["child"],
    ]);
  });

  it("accepts separate floors for one package in disjoint configurations, not overlapping ones", () => {
    const errorprone = { ...guavaFloor, selector: [":errorprone"], version: "33.8.0-jre" };
    expect(parseFloors({ floors: [guavaFloor, errorprone] })).toHaveLength(2);
    expect(() => parseFloors({ floors: [guavaFloor, { ...errorprone, selector: [":errorprone", ":checkstyle"] }] })).toThrow(
      "duplicates an earlier floor for com.google.guava:guava in build.gradle.kts (:checkstyle)",
    );
  });

  it("rejects malformed entries, security floors without advisories, and duplicates", () => {
    expect(() => parseFloors([])).toThrow('must be { "floors": [...] }');
    expect(() => parseFloors({ floors: [{ ...guavaFloor, ecosystem: "pip" }] })).toThrow("ecosystem must be npm or Maven");
    expect(() => parseFloors({ floors: [{ ...guavaFloor, advisories: [] }] })).toThrow("a security floor names the advisories it fixes");
    expect(() => parseFloors({ floors: [{ ...guavaFloor, purpose: "compatibility" }] })).toThrow("a compatibility floor names no advisories");
    expect(() => parseFloors({ floors: [{ ...guavaFloor, advisories: ["bad-id"] }] })).toThrow("must list GHSA-, CVE- or MAL- ids");
    expect(() => parseFloors({ floors: [{ ...guavaFloor, added: "2026-13-01" }] })).toThrow("real YYYY-MM-DD");
    expect(() => parseFloors({ floors: [{ ...guavaFloor, extra: 1 }] })).toThrow("unknown field(s): extra");
    expect(() => parseFloors({ floors: [guavaFloor, guavaFloor] })).toThrow("duplicates an earlier floor");
    expect(() => parseFloors({ floors: [{ ...guavaFloor, selector: [[":checkstyle"]] }] })).toThrow("must list Gradle configuration locations");
  });
});

function tree(files: Record<string, string>): Tree {
  return { id: "head", read: async (path) => files[path], list: async () => [] };
}

function gradleInventory(configurations: Partial<GradleConfiguration>[]): Inventory {
  const gradle: GradleInventory = {
    schemaVersion: 1,
    tree: "head",
    builds: [
      {
        build: ".",
        configurations: configurations.map((config) => ({
          id: ":x",
          kind: "project",
          resolved: [],
          unresolved: [],
          declared: [],
          error: undefined,
          ...config,
        })),
      },
    ],
  };
  return { tree: "head", npm: [], gradle, actions: { uses: [], docker: [], files: [], gaps: [] } };
}

describe("Gradle floors", () => {
  const files = { "build.gradle.kts": "// …" };
  const guava = (version: string) => ({ group: "com.google.guava", name: "guava", version });

  it("passes a floor declared with its advisory and resolved at or above it", async () => {
    const inventory = gradleInventory([
      {
        id: ":checkstyle",
        declared: [{ ...guava("33.7.2-jre"), reason: "CVE-2026-102554: prevents excessive allocation" }],
        resolved: [guava("33.7.2-jre")],
      },
    ]);
    expect(await checkFloors(parseFloors({ floors: [guavaFloor] }), inventory, tree(files))).toEqual({ failures: [], notes: [] });
  });

  it("fails a missing declaration, a reason without the advisory, a version below the floor, and an unknown configuration", async () => {
    const floors = parseFloors({ floors: [{ ...guavaFloor, selector: [":checkstyle", ":errorprone", ":pmd"] }] });
    const inventory = gradleInventory([
      { id: ":checkstyle", declared: [{ ...guava("33.7.2-jre"), reason: "newer is better" }], resolved: [guava("33.7.1-jre")] },
      { id: ":errorprone", declared: [{ ...guava("33.5.0-jre"), reason: undefined }], resolved: [guava("33.7.2-jre")] },
    ]);
    expect((await checkFloors(floors, inventory, tree(files))).failures).toEqual([
      "floor com.google.guava:guava 33.7.2-jre (build.gradle.kts): :checkstyle's because(...) doesn't name CVE-2026-102554",
      "floor com.google.guava:guava 33.7.2-jre (build.gradle.kts): :checkstyle resolves com.google.guava:guava:33.7.1-jre, below the floor",
      "floor com.google.guava:guava 33.7.2-jre (build.gradle.kts): :errorprone doesn't declare com.google.guava:guava:33.7.2-jre (declares 33.5.0-jre)",
      "floor com.google.guava:guava 33.7.2-jre (build.gradle.kts): Gradle has no resolvable configuration :pmd",
    ]);
    expect((await checkFloors(floors, inventory, tree({}))).failures).toEqual([
      "floor com.google.guava:guava 33.7.2-jre (build.gradle.kts): build.gradle.kts isn't in head",
    ]);
  });

  it("notes a because(...) declaration no floor entry covers in that configuration and version", async () => {
    const inventory = gradleInventory([
      { id: ":checkstyle", declared: [{ ...guava("33.7.2-jre"), reason: "CVE-2026-102554 fix" }], resolved: [guava("33.7.2-jre")] },
      { id: ":errorprone", declared: [{ ...guava("33.7.2-jre"), reason: "needs the newer API" }], resolved: [guava("33.7.2-jre")] },
    ]);
    const floors = parseFloors({ floors: [{ ...guavaFloor, reason: "fix" }] });
    const notes = (await checkFloors(floors, inventory, tree(files))).notes;
    expect(notes).toEqual([
      'com.google.guava:guava:33.7.2-jre is declared in :errorprone because "needs the newer API" without an entry in .github/dependency-floors.json',
    ]);
  });
});

describe("npm floors", () => {
  const lock = (copies: Record<string, string>) =>
    lockedPackages({
      lockfileVersion: 3,
      packages: Object.fromEntries(
        Object.entries(copies).map(([path, version]) => [path, { version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz` }]),
      ),
    });
  const inventory = (copies: Record<string, string>): Inventory => ({
    tree: "head",
    npm: [{ path: "package-lock.json", packages: lock(copies), bundleProblems: [] }],
    gradle: undefined,
    actions: { uses: [], docker: [], files: [], gaps: [] },
  });
  const floor = {
    ecosystem: "npm",
    package: "brace-expansion",
    version: "5.0.10",
    declaredIn: "package.json",
    selector: "brace-expansion",
    purpose: "security",
    advisories: ["GHSA-6j4f-fj2g-mc7p"],
    reason: "minimatch pulls an affected brace-expansion",
    added: "2026-10-06",
  };
  const manifest = (overrides: unknown) => ({ "package.json": JSON.stringify({ name: "app", overrides }) });

  it("passes an override at or above the floor with every copy above it", async () => {
    const floors = parseFloors({ floors: [floor] });
    const copies = { "node_modules/brace-expansion": "5.0.11", "node_modules/a/node_modules/brace-expansion": "5.0.10" };
    for (const spec of ["5.0.10", "^5.0.10", "~5.0.11", ">=5.0.10"]) {
      expect(await checkFloors(floors, inventory(copies), tree(manifest({ "brace-expansion": spec })))).toEqual({ failures: [], notes: [] });
    }
    const nested = parseFloors({ floors: [{ ...floor, selector: [["minimatch", "brace-expansion"]] }] });
    expect((await checkFloors(nested, inventory(copies), tree(manifest({ minimatch: { "brace-expansion": "5.0.10" } })))).failures).toEqual([]);
    expect((await checkFloors(nested, inventory(copies), tree(manifest({ minimatch: { "brace-expansion": { ".": "5.0.10" } } })))).failures).toEqual([]);
    // A version-qualified key, which `>` can't separate.
    const qualified = parseFloors({ floors: [{ ...floor, selector: [["minimatch@>=10.0.0", "brace-expansion@^5"]] }] });
    expect((await checkFloors(qualified, inventory(copies), tree(manifest({ "minimatch@>=10.0.0": { "brace-expansion@^5": "5.0.10" } })))).failures).toEqual([]);
  });

  it("fails a selector that points at another package's override", async () => {
    const floors = parseFloors({ floors: [{ ...floor, selector: "other" }] });
    const copies = { "node_modules/brace-expansion": "5.0.11", "node_modules/other": "9.0.0" };
    expect((await checkFloors(floors, inventory(copies), tree(manifest({ other: "9.0.0" })))).failures).toEqual([
      "floor brace-expansion 5.0.10 (package.json): the override other is for other, not brace-expansion",
      "package.json overrides other without an entry in .github/dependency-floors.json",
    ]);
  });

  it("fails an override that admits lower versions, a copy below the floor, and an override without an entry", async () => {
    const floors = parseFloors({ floors: [floor] });
    expect((await checkFloors(floors, inventory({ "node_modules/brace-expansion": "5.0.10" }), tree(manifest({ "brace-expansion": "*" })))).failures).toEqual([
      'floor brace-expansion 5.0.10 (package.json): the override brace-expansion is "*"; a floor needs x, ^x, ~x or >=x',
    ]);
    expect((await checkFloors(floors, inventory({ "node_modules/brace-expansion": "5.0.10" }), tree(manifest({ "brace-expansion": "^5.0.9" })))).failures).toEqual([
      'floor brace-expansion 5.0.10 (package.json): the override brace-expansion is "^5.0.9", below the floor',
    ]);
    expect((await checkFloors(floors, inventory({ "node_modules/x/node_modules/brace-expansion": "5.0.9" }), tree(manifest({ "brace-expansion": "5.0.10" })))).failures).toEqual([
      "floor brace-expansion 5.0.10 (package.json): package-lock.json has brace-expansion@5.0.9 at node_modules/x/node_modules/brace-expansion, below the floor",
    ]);
    expect((await checkFloors([], inventory({}), tree(manifest({ "brace-expansion": "5.0.10", vite: { esbuild: "0.25.0" } })))).failures).toEqual([
      "package.json overrides brace-expansion without an entry in .github/dependency-floors.json",
      "package.json overrides vite > esbuild without an entry in .github/dependency-floors.json",
    ]);
  });
});
