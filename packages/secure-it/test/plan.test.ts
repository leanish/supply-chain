import { describe, expect, it } from "vitest";

import type { SecurityFix } from "../../ci/src/candidates.ts";
import type { GradleInventory } from "../../ci/src/gradle.ts";
import { planFor, selectWork } from "../src/plan.ts";

function fix(overrides: Partial<SecurityFix> & Pick<SecurityFix, "name" | "from">): SecurityFix {
  return {
    ecosystem: "npm",
    locations: [`node_modules/${overrides.name}`],
    targets: ["GHSA-a"],
    unfixable: [],
    malicious: false,
    severity: "HIGH",
    to: { version: "9.9.9", line: "9", aged: true, major: false, blockers: [] },
    problem: undefined,
    ...overrides,
  };
}

const NO_TAGS = async () => undefined;

const names = (fixes: ReadonlyArray<SecurityFix>) => fixes.map((f) => f.name);

describe("selectWork", () => {
  it("takes malware together, otherwise batches non-majors in severity/name order", () => {
    const evil = fix({ name: "evil", from: "1.0.0", malicious: true, severity: undefined });
    const worse = fix({ name: "worse", from: "1.0.0", malicious: true });
    const critical = fix({ name: "zlib", from: "1.0.0", severity: "CRITICAL" });
    const high = fix({ name: "alpha", from: "1.0.0", severity: "HIGH" });
    expect(names(selectWork([high, critical, evil, worse]).units[0]!.work)).toEqual(["evil", "worse"]);
    expect(names(selectWork([high, critical]).units[0]!.work)).toEqual(["zlib", "alpha"]);
    expect(names(selectWork([fix({ name: "b", from: "1.0.0" }), fix({ name: "a", from: "1.0.0" })]).units[0]!.work)).toEqual(["a", "b"]);
  });

  it("keeps every failing copy together, and reports blocked groups without blocking the batch", () => {
    const old = fix({ name: "guava", from: "33.5.0-jre", ecosystem: "Maven" });
    const newer = fix({ name: "guava", from: "33.7.1-jre", ecosystem: "Maven" });
    const blocked = fix({ name: "aaa", from: "1.0.0", severity: "CRITICAL", to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: ["identity break"] } });
    const partly = fix({ name: "aab", from: "1.0.0", severity: "CRITICAL" });
    const stuck = fix({ name: "aab", from: "2.0.0", severity: "CRITICAL", to: undefined, problem: "no fix" });
    const selection = selectWork([old, blocked, partly, stuck, newer]);
    expect(selection.units[0]!.work.map((f) => f.from)).toEqual(["33.5.0-jre", "33.7.1-jre"]);
    expect(selection.blocked).toEqual([
      { packages: ["npm|aaa"], reasons: ["aaa@1.0.0: identity break"] },
      { packages: ["npm|aab"], reasons: ["aab@2.0.0: no fix"] },
    ]);
  });

  it("keeps majors apart and groups all copies of a major package", () => {
    const minor = fix({ name: "a", from: "1.0.0" });
    const major = fix({ name: "a", from: "2.0.0", to: { version: "3.0.0", line: "3", aged: true, major: true, blockers: [] } });
    const routine = fix({ name: "b", from: "1.0.0", ecosystem: "Maven" });
    const selected = selectWork([minor, major, routine]);
    expect(selected.units.map((unit) => [unit.kind, unit.topic, unit.work.map((entry) => entry.from)])).toEqual([
      ["routine", "security", ["1.0.0"]], ["major", "a-major", ["1.0.0", "2.0.0"]],
    ]);
  });

  it("takes no malware at all when one malicious version can't move", () => {
    const selection = selectWork([fix({ name: "evil", from: "1.0.1", malicious: true }), fix({ name: "worse", from: "1.0.0", malicious: true, to: undefined, problem: "no clean version" }), fix({ name: "x", from: "1.0.0" })]);
    expect(selection).toEqual({ units: [], blocked: [{ packages: ["npm|evil", "npm|worse"], reasons: ["worse@1.0.0: no clean version"] }] });
  });
});

describe("planFor", () => {
  it("chooses npm-direct for a declared dependency, npm-lock when every parent range allows the fix, else npm-override", async () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { name: "app", dependencies: { vite: "^8.3.0", postcss: "^8.4.0" } },
        "node_modules/vite": { version: "8.3.1" },
        "node_modules/postcss": { version: "8.4.0", dependencies: { "source-map-js": "^1.2.0" } },
        "node_modules/source-map-js": { version: "1.2.1" },
        "node_modules/legacy": { version: "1.0.0", dependencies: { "brace-expansion": "~1.1.0" } },
        "node_modules/brace-expansion": { version: "1.1.0" },
      },
    };
    const lockfiles = new Map([["package-lock.json", lock]]);
    const plan = await planFor(
      [
        fix({ name: "vite", from: "8.3.1", to: { version: "8.3.3", line: "8", aged: false, major: false, blockers: [] } }),
        fix({ name: "source-map-js", from: "1.2.1", to: { version: "1.2.2", line: "1", aged: true, major: false, blockers: [] } }),
        fix({ name: "brace-expansion", from: "1.1.0", to: { version: "2.0.2", line: "2", aged: true, major: true, blockers: [] } }),
      ],
      { lockfiles, gradle: undefined, tagCommit: NO_TAGS },
    );
    expect(plan.moves.map((move) => [move.name, move.mechanism, move.to, move.major])).toEqual([
      ["vite", "npm-direct", "8.3.3", false],
      ["source-map-js", "npm-lock", "1.2.2", false],
      ["brace-expansion", "npm-override", "2.0.2", true],
    ]);
    expect(plan.topic).toBe("vite-major");
  });

  it("reads a nested lockfile's locations against that lockfile, and resolves copies the way Node does", async () => {
    const root = { packages: { "": { name: "app" } } };
    const nested = {
      packages: {
        "": { name: "clis", dependencies: { tool: "^1.0.0" } },
        "node_modules/tool": { version: "1.0.0", dependencies: { lib: "^2.0.0" } },
        "node_modules/tool/node_modules/lib": { version: "2.0.0" },
        "node_modules/lib": { version: "1.0.0" },
      },
    };
    const lockfiles = new Map<string, unknown>([
      ["package-lock.json", root],
      ["tools/clis/package-lock.json", nested],
    ]);
    const plan = await planFor([fix({ name: "lib", from: "2.0.0", locations: ["tools/clis/node_modules/tool/node_modules/lib"], to: { version: "2.1.0", line: "2", aged: true, major: false, blockers: [] } })], {
      lockfiles,
      gradle: undefined,
      tagCommit: NO_TAGS,
    });
    expect(plan.moves[0]?.mechanism).toBe("npm-lock");
  });

  it("chooses gradle-declared where the configuration declares the module, gradle-floor elsewhere, and pins actions to the tag's commit", async () => {
    const gradle = {
      tree: "worktree",
      builds: [
        {
          build: ".",
          configurations: [
            { id: ":runtimeClasspath", kind: "project", resolved: [], unresolved: [], declared: [{ group: "org.xerial.snappy", name: "snappy-java", version: "1.1.10.8", reason: undefined }], error: undefined },
            { id: ":checkstyle", kind: "project", resolved: [], unresolved: [], declared: [], error: undefined },
          ],
        },
      ],
    } as unknown as GradleInventory;
    const plan = await planFor(
      [
        fix({ ecosystem: "Maven", name: "org.xerial.snappy:snappy-java", from: "1.1.10.8", locations: [":runtimeClasspath", ":checkstyle"] }),
        fix({ ecosystem: "GitHub Actions", name: "actions/checkout", from: "v4.2.2", locations: [".github/workflows/ci.yml"], to: { version: "v4.2.3", line: "4", aged: true, major: false, blockers: [] } }),
      ],
      { lockfiles: new Map(), gradle, tagCommit: async (action, tag) => (action === "actions/checkout" && tag === "v4.2.3" ? "a".repeat(40) : undefined) },
    );
    expect(plan.moves.map((move) => [move.mechanism, move.locations, move.commitSha])).toEqual([
      ["gradle-declared", [":runtimeClasspath"], undefined],
      ["gradle-floor", [":checkstyle"], undefined],
      ["action-pin", [".github/workflows/ci.yml"], "a".repeat(40)],
    ]);
    await expect(planFor([fix({ ecosystem: "GitHub Actions", name: "x/y", from: "v1", locations: ["w.yml"] })], { lockfiles: new Map(), gradle, tagCommit: NO_TAGS })).rejects.toThrow("has no tag 9.9.9");
  });

  it("targets only the fixable advisories, and keeps an npm alias's key for the edit", async () => {
    const lockfiles = new Map([["package-lock.json", { packages: { "": { name: "app", dependencies: { compat: "npm:lib@^1.0.0" } }, "node_modules/compat": { name: "lib", version: "1.0.0" } } }]]);
    const plan = await planFor([fix({ name: "lib", from: "1.0.0", locations: ["node_modules/compat"], targets: ["GHSA-a", "GHSA-b"], unfixable: ["GHSA-b"], to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] } })], {
      lockfiles,
      gradle: undefined,
      tagCommit: NO_TAGS,
    });
    expect(plan.moves).toEqual([expect.objectContaining({ mechanism: "npm-direct", declaredAs: "compat", advisories: ["GHSA-a"] })]);
  });

  it("names a malware plan `malware` and lists every package", async () => {
    const lockfiles = new Map([["package-lock.json", { packages: { "": { name: "app", dependencies: { a: "^1", b: "^1" } }, "node_modules/a": { version: "1.0.1" }, "node_modules/b": { version: "1.0.1" } } }]]);
    const plan = await planFor([fix({ name: "a", from: "1.0.1", malicious: true }), fix({ name: "b", from: "1.0.1", malicious: true })], { lockfiles, gradle: undefined, tagCommit: NO_TAGS });
    expect(plan).toMatchObject({ topic: "malware", malware: true, packages: ["npm|a", "npm|b"] });
  });
});
