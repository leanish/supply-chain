import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { SecurityFix } from "../../ci/src/candidates.ts";
import { parseConfig } from "../../ci/src/config.ts";
import type { GateEnvironment } from "../../ci/src/gate.ts";
import type { GradleConfiguration, GradleInventory } from "../../ci/src/gradle.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { fakeFetch } from "../../ci/test/fake-fetch.ts";
import type { GradleTransform } from "../../remediation/src/inventories.ts";
import { PARENT_PROBES, withGradleParents } from "../src/gradle-parents.ts";
import { planFor } from "../src/plan.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const OKHTTP = "com.squareup.okhttp3:okhttp";
const OKIO = "com.squareup.okio:okio";
const CENTRAL = "https://repo1.maven.org/maven2";

/** okhttp's versions with the okio each brings; every one aged unless listed in `young`. */
const BRINGS: Record<string, string> = { "4.9.1": "2.8.0", "4.9.2": "2.8.0", "4.9.3": "2.8.0", "4.10.0": "3.0.0", "4.11.0": "3.2.0", "4.12.0": "3.6.0" };
const AFFECTED: Record<string, string[]> = {
  "com.squareup.okio:okio@2.8.0": ["GHSA-okio"], "com.squareup.okio:okio@3.0.0": ["GHSA-okio"], "com.squareup.okio:okio@3.2.0": ["GHSA-okio"],
  "com.squareup.okhttp3:okhttp@4.9.1": ["GHSA-okhttp"],
};

function environment(young: ReadonlyArray<string> = [], affected = AFFECTED, brings = BRINGS): GateEnvironment {
  const run: RunProcess = async (command, args, options) => {
    if (command !== "osv-scanner") return runProcess(command, args, options);
    if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
    const inventory = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
      results: Array<{ packages: Array<{ package: { name: string; version: string; ecosystem: string } }> }>;
    };
    const packages = inventory.results[0]!.packages.map(({ package: pkg }) => ({
      package: pkg, vulnerabilities: (affected[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id, summary: id })),
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
  const routes: Parameters<typeof fakeFetch>[0] = {
    [`${CENTRAL}/com/squareup/okhttp3/okhttp/maven-metadata.xml`]: { text: `<metadata><versioning><versions>${Object.keys(brings).map((version) => `<version>${version}</version>`).join("")}</versions></versioning></metadata>` },
  };
  for (const version of Object.keys(brings)) {
    routes[`${CENTRAL}/com/squareup/okhttp3/okhttp/${version}/okhttp-${version}.pom`] = {
      headers: { "last-modified": young.includes(version) ? "Thu, 08 Oct 2026 00:00:00 GMT" : "Mon, 01 Jun 2026 00:00:00 GMT" }, text: "<project></project>",
    };
  }
  for (const version of new Set(Object.values(brings))) {
    routes[`${CENTRAL}/com/squareup/okio/okio/${version}/okio-${version}.pom`] = { headers: { "last-modified": "Mon, 01 Jun 2026 00:00:00 GMT" }, text: "<project></project>" };
  }
  return { run, fetch: fakeFetch(routes), now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined };
}

function configuration(id: string, okhttp: string, moved = false, edges = true, brings = BRINGS): GradleConfiguration {
  const okio = brings[okhttp]!;
  return {
    id, kind: "project",
    resolved: [{ group: "com.squareup.okhttp3", name: "okhttp", version: okhttp }, { group: "com.squareup.okio", name: "okio", version: okio }],
    unresolved: [],
    declared: [{ group: "com.squareup.okhttp3", name: "okhttp", version: okhttp, reason: undefined, ...(moved ? { moved: true as const } : {}) }],
    ...(edges ? { edges: [{ from: "project :", to: `${OKHTTP}:${okhttp}`, constraint: false }, { from: `${OKHTTP}:${okhttp}`, to: `${OKIO}:${okio}`, constraint: false }] } : {}),
    error: undefined,
  };
}

const inventory = (okhttp: string, moved = false, edges = true, brings = BRINGS): GradleInventory => ({
  schemaVersion: 2, tree: "base", builds: [{ build: ".", configurations: [configuration(":compileClasspath", okhttp, moved, edges, brings), configuration(":runtimeClasspath", okhttp, moved, edges, brings)] }],
});

const BASE: Tree = { id: "base", read: async () => undefined, list: async () => [] };

/** Answers each reference run with okhttp moved where the transform says; records each probe's target. */
function references(probes: string[], fail = false, brings = BRINGS) {
  return {
    ofCommit: async (_tree: Tree, change?: { readonly transform?: GradleTransform }) => {
      if (fail) throw new Error("the sandboxed Gradle inventory failed");
      const to = (change!.transform!.content(".") as { moves: Array<{ to: string }> }).moves[0]!.to;
      probes.push(to);
      return inventory(to, true, true, brings);
    },
  };
}

const okio = (overrides: Partial<SecurityFix> = {}): SecurityFix => ({
  ecosystem: "Maven", name: OKIO, from: "2.8.0", locations: [":compileClasspath", ":runtimeClasspath"], targets: ["GHSA-okio"], unfixable: [], malicious: false, severity: "MODERATE",
  to: { version: "3.6.0", line: "3", aged: true, major: true, blockers: [] }, problem: undefined, ...overrides,
});

async function search(work: SecurityFix[], options: { base?: string; probes?: string[]; young?: string[]; fail?: boolean; edges?: boolean } = {}) {
  const gradle = inventory(options.base ?? "4.9.3", false, options.edges ?? true);
  const result = await withGradleParents(work, {
    base: BASE, gradle, named: (group) => group === "com.squareup.okhttp3", inventories: references(options.probes ?? [], options.fail),
    env: environment(options.young), config: parseConfig({}),
  });
  return { ...result, plan: await planFor(result.fixes, { named: (group) => group === "com.squareup.okhttp3", lockfiles: new Map(), gradle, tagCommit: async () => undefined }) };
}

describe("moving a Gradle parent instead of flooring what it brings", () => {
  it("probes okhttp's aged versions lowest first and moves it to the first that brings a fixed okio", async () => {
    const probes: string[] = [];
    const { plan, notes } = await search([okio()], { probes });
    expect(notes).toEqual([]);
    expect(probes).toEqual(["4.10.0", "4.11.0", "4.12.0"]);
    expect(plan.moves).toEqual([expect.objectContaining({
      name: OKHTTP, from: "4.9.3", to: "4.12.0", mechanism: "gradle-declared", locations: [":compileClasspath", ":runtimeClasspath"], advisories: [],
      carries: [{ name: OKIO, from: ["2.8.0"], to: ["3.6.0"], locations: [":compileClasspath", ":runtimeClasspath"], advisories: ["GHSA-okio"] }],
    })]);
  });

  it("makes one move fix okhttp's own advisory and the okio it brings", async () => {
    const own: SecurityFix = { ...okio(), name: OKHTTP, from: "4.9.1", targets: ["GHSA-okhttp"], to: { version: "4.9.2", line: "4", aged: true, major: false, blockers: [] } };
    const probes: string[] = [];
    const { plan } = await search([own, okio()], { base: "4.9.1", probes });
    expect(probes[0]).toBe("4.9.2");
    expect(plan.moves).toEqual([expect.objectContaining({ name: OKHTTP, from: "4.9.1", to: "4.12.0", advisories: ["GHSA-okhttp"], carries: [expect.objectContaining({ name: OKIO, advisories: ["GHSA-okio"] })] })]);
  });

  it("skips young parent versions", async () => {
    const probes: string[] = [];
    const { plan, notes } = await search([okio()], { probes, young: ["4.12.0"] });
    expect(probes).toEqual(["4.10.0", "4.11.0"]);
    expect(plan.moves.map((move) => [move.name, move.mechanism])).toEqual([[OKIO, "gradle-floor"]]);
    expect(notes).toEqual([expect.stringContaining("no version past the wait brings")]);
  });

  it.each([
    ["the inventory doesn't record edges", { edges: false }, "doesn't record who brings it"],
    ["a reference run fails", { fail: true }, "searching its parents failed"],
  ])("keeps the floor when %s", async (_, options, note) => {
    const { plan, notes } = await search([okio()], options);
    expect(plan.moves.every((move) => move.mechanism === "gradle-floor")).toBe(true);
    expect(notes).toEqual([expect.stringContaining(note)]);
  });

  it("stops at its probe budget, shared by the module's roots, and keeps the floor", async () => {
    const brings: Record<string, string> = { "4.9.3": "2.8.0", ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`4.9.${4 + i}`, "2.8.0"])), "4.12.0": "3.6.0" };
    const probes: string[] = [];
    const result = await withGradleParents([okio()], {
      base: BASE, gradle: inventory("4.9.3", false, true, brings), named: (group) => group === "com.squareup.okhttp3", inventories: references(probes, false, brings),
      env: environment([], AFFECTED, brings), config: parseConfig({}),
    });
    expect(probes).toHaveLength(PARENT_PROBES);
    expect(result.notes).toEqual([expect.stringContaining("the probe budget is spent")]);
    expect(result.fixes).toEqual([okio()]);
  });
});
