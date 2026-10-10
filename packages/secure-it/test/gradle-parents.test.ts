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
  const fixes = await withGradleParents(work, {
    base: BASE, gradle, named: (group) => group === "com.squareup.okhttp3", inventories: references(options.probes ?? [], options.fail),
    env: environment(options.young), config: parseConfig({}),
  });
  const plan = await planFor(fixes, { named: (group) => group === "com.squareup.okhttp3", lockfiles: new Map(), gradle, tagCommit: async () => undefined });
  return { fixes, notes: plan.notes ?? [], plan };
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
    const fixes = await withGradleParents([okio()], {
      base: BASE, gradle: inventory("4.9.3", false, true, brings), named: (group) => group === "com.squareup.okhttp3", inventories: references(probes, false, brings),
      env: environment([], AFFECTED, brings), config: parseConfig({}),
    });
    expect(probes).toHaveLength(PARENT_PROBES);
    expect(fixes).toEqual([{ ...okio(), notes: [expect.stringContaining("the probe budget is spent")] }]);
  });
});

describe("Gradle parents, regressions", () => {
  const D = "g:d";
  const X = "g:x";
  const Y = "g:y";
  /** d's version → what it brings: module → version (absent: not brought); `unresolved` leaves a dependency unresolved. */
  type Brings = Record<string, { x?: string; y?: string; unresolved?: boolean }>;
  const config = (id: string, d: string, brings: Brings, extra: Partial<GradleConfiguration> = {}): GradleConfiguration => {
    const { x, y, unresolved } = brings[d]!;
    const edges = [{ from: "root project 'app'", to: `${D}:${d}`, constraint: false },
      ...(x === undefined ? [] : [{ from: `${D}:${d}`, to: `${X}:${x}`, constraint: false }]),
      ...(y === undefined ? [] : [{ from: `${D}:${d}`, to: `${Y}:${y}`, constraint: false }])];
    return {
      id, kind: "project",
      resolved: [{ group: "g", name: "d", version: d }, ...(x === undefined ? [] : [{ group: "g", name: "x", version: x }]), ...(y === undefined ? [] : [{ group: "g", name: "y", version: y }])],
      unresolved: unresolved === true ? [{ requested: `${X}:9`, failure: "not found" }] : [],
      declared: [{ group: "g", name: "d", version: d, reason: undefined }], edges, error: undefined, ...extra,
    };
  };
  const gradleOf = (d: string, brings: Brings, moved = false): GradleInventory => ({ schemaVersion: 2, tree: "base", builds: [{ build: ".", configurations: [
    { ...config(":runtimeClasspath", d, brings), declared: [{ group: "g", name: "d", version: d, reason: undefined, ...(moved ? { moved: true as const } : {}) }] },
  ] }] });
  function env(brings: Brings, affected: Record<string, string[]>): GateEnvironment {
    const base = environment([], affected);
    const routes: Parameters<typeof fakeFetch>[0] = {
      [`${CENTRAL}/g/d/maven-metadata.xml`]: { text: `<metadata><versioning><versions>${Object.keys(brings).map((version) => `<version>${version}</version>`).join("")}</versions></versioning></metadata>` },
    };
    for (const version of Object.keys(brings)) routes[`${CENTRAL}/g/d/${version}/d-${version}.pom`] = { headers: { "last-modified": "Mon, 01 Jun 2026 00:00:00 GMT" }, text: "<project></project>" };
    for (const [module, versions] of [["x", ["1.0", "1.1", "2.0"]], ["y", ["1.0", "1.1", "2.0"]]] as const) {
      for (const version of versions) routes[`${CENTRAL}/g/${module}/${version}/${module}-${version}.pom`] = { headers: { "last-modified": "Mon, 01 Jun 2026 00:00:00 GMT" }, text: "<project></project>" };
    }
    return { ...base, fetch: fakeFetch(routes) };
  }
  const references = (brings: Brings, probes: string[] = []) => ({
    ofCommit: async (_tree: Tree, change?: { readonly transform?: GradleTransform }) => {
      const to = (change!.transform!.content(".") as { moves: Array<{ to: string }> }).moves[0]!.to;
      probes.push(to);
      return gradleOf(to, brings, true);
    },
  });
  const fixOf = (name: string, from: string, advisory: string): SecurityFix => ({
    ecosystem: "Maven", name, from, locations: [":runtimeClasspath"], targets: [advisory], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: "2.0", line: "2", aged: true, major: true, blockers: [] }, problem: undefined,
  });
  const run = (work: SecurityFix[], brings: Brings, affected: Record<string, string[]>, probes: string[] = []) =>
    withGradleParents(work, { base: BASE, gradle: gradleOf("1.0", brings), named: (group, name) => group === "g" && name === "d", inventories: references(brings, probes), env: env(brings, affected), config: parseConfig({}) });

  it("re-proves everything the parent already carries with each candidate", async () => {
    const brings: Brings = { "1.0": { x: "1.0", y: "1.0" }, "1.1": { x: "2.0", y: "1.0" }, "1.2": { x: "1.0", y: "2.0" }, "1.3": { x: "2.0", y: "2.0" } };
    const affected = { "g:x@1.0": ["GHSA-x"], "g:y@1.0": ["GHSA-y"] };
    const fixes = await run([fixOf(X, "1.0", "GHSA-x"), fixOf(Y, "1.0", "GHSA-y")], brings, affected);
    expect(fixes).toEqual([expect.objectContaining({ name: D, to: expect.objectContaining({ version: "1.3" }), carries: [
      expect.objectContaining({ name: X, to: ["2.0"] }), expect.objectContaining({ name: Y, to: ["2.0"] }),
    ] })]);
  });

  it("doesn't take a dependency that no longer resolves for one that's gone", async () => {
    const brings: Brings = { "1.0": { x: "1.0" }, "1.1": { unresolved: true }, "1.2": { x: "2.0" } };
    const fixes = await run([fixOf(X, "1.0", "GHSA-x")], brings, { "g:x@1.0": ["GHSA-x"] });
    expect(fixes).toEqual([expect.objectContaining({ name: D, to: expect.objectContaining({ version: "1.2" }) })]);
  });

  it("keeps the floor when the declaration brings it in only some of the vulnerable configurations", async () => {
    const brings: Brings = { "1.0": { x: "1.0" }, "1.1": { x: "2.0" } };
    const gradle: GradleInventory = { schemaVersion: 2, tree: "base", builds: [{ build: ".", configurations: [
      config(":runtimeClasspath", "1.0", brings),
      { ...config(":testRuntimeClasspath", "1.0", brings), edges: [{ from: "root project 'app'", to: `${X}:1.0`, constraint: false }] },
    ] }] };
    const fix = { ...fixOf(X, "1.0", "GHSA-x"), locations: [":runtimeClasspath", ":testRuntimeClasspath"] };
    const fixes = await withGradleParents([fix], { base: BASE, gradle, named: (group, name) => group === "g" && name === "d", inventories: references(brings), env: env(brings, { "g:x@1.0": ["GHSA-x"] }), config: parseConfig({}) });
    expect(fixes).toEqual([{ ...fix, notes: [expect.stringContaining("no declared dependency brings it in every vulnerable configuration")] }]);
  });

  it("keeps the floor when the root's own blocked fix can't be fixed by the same move", async () => {
    const brings: Brings = { "1.0": { x: "1.0" }, "1.1": { x: "2.0" }, "1.2": { x: "2.0" } };
    // d has two advisories: 1.1 fixes only A, 1.2 only B; no version fixes both, so its own fix is blocked.
    const affected = { "g:x@1.0": ["GHSA-x"], "g:d@1.0": ["GHSA-a", "GHSA-b"], "g:d@1.1": ["GHSA-b"], "g:d@1.2": ["GHSA-a"] };
    const blocked: SecurityFix = { ...fixOf(D, "1.0", "GHSA-a"), targets: ["GHSA-a", "GHSA-b"], to: undefined, problem: "no single version above 1.0 fixes all of GHSA-a, GHSA-b" };
    const fixes = await run([fixOf(X, "1.0", "GHSA-x"), blocked], brings, affected);
    expect(fixes.find((fix) => fix.name === D)).toEqual(blocked);
    expect(fixes.find((fix) => fix.name === X)?.notes).toEqual([expect.stringContaining("brings an advisory of its own or leaves its own")]);
  });

  it("tries a root that's a failing fix itself first, and shares one probe budget across roots", async () => {
    const E = "g:e";
    const versions = ["1.0", "1.1", "1.2", "1.3", "1.4"];
    const gradle: GradleInventory = { schemaVersion: 2, tree: "base", builds: [{ build: ".", configurations: [{
      id: ":runtimeClasspath", kind: "project",
      resolved: [{ group: "g", name: "d", version: "1.0" }, { group: "g", name: "e", version: "1.0" }, { group: "g", name: "x", version: "1.0" }],
      unresolved: [], error: undefined,
      declared: [{ group: "g", name: "d", version: "1.0", reason: undefined }, { group: "g", name: "e", version: "1.0", reason: undefined }],
      edges: [{ from: "root project 'app'", to: `${D}:1.0`, constraint: false }, { from: "root project 'app'", to: `${E}:1.0`, constraint: false },
        { from: `${D}:1.0`, to: `${X}:1.0`, constraint: false }, { from: `${E}:1.0`, to: `${X}:1.0`, constraint: false }],
    }] }] };
    const probes: string[] = [];
    const inventories = { ofCommit: async (_tree: Tree, change?: { readonly transform?: GradleTransform }) => {
      const move = (change!.transform!.content(".") as { moves: Array<{ name: string; to: string }> }).moves[0]!;
      probes.push(`${move.name}:${move.to}`);
      const configuration = gradle.builds[0]!.configurations[0]!;
      // Nothing fixes x: every probe keeps 1.0.
      return { ...gradle, builds: [{ build: ".", configurations: [{ ...configuration, declared: configuration.declared.map((entry) => (`${entry.group}:${entry.name}` === move.name ? { ...entry, version: move.to, moved: true as const } : entry)) }] }] };
    } };
    const base = env(Object.fromEntries(versions.map((version) => [version, {}])), { "g:x@1.0": ["GHSA-x"], "g:e@1.0": ["GHSA-e"] });
    const routes: Parameters<typeof fakeFetch>[0] = { [`${CENTRAL}/g/e/maven-metadata.xml`]: { text: `<metadata><versioning><versions>${versions.map((version) => `<version>${version}</version>`).join("")}</versions></versioning></metadata>` } };
    for (const version of versions) routes[`${CENTRAL}/g/e/${version}/e-${version}.pom`] = { headers: { "last-modified": "Mon, 01 Jun 2026 00:00:00 GMT" }, text: "<project></project>" };
    const fetch = base.fetch;
    const both: GateEnvironment = { ...base, fetch: async (url, init) => (routes[url] !== undefined ? fakeFetch(routes)(url, init) : fetch(url, init)) };
    const own = { ...fixOf(E, "1.0", "GHSA-e"), to: { version: "1.1", line: "1", aged: true, major: false, blockers: [] } };
    const fixes = await withGradleParents([fixOf(X, "1.0", "GHSA-x"), own], { base: BASE, gradle, named: (group) => group === "g", inventories, env: both, config: parseConfig({}) });
    expect(probes[0]).toMatch(/^g:e:/);
    expect(probes).toHaveLength(PARENT_PROBES);
    expect(fixes.find((fix) => fix.name === X)?.notes).toEqual([expect.stringContaining("the probe budget is spent")]);
  });

  it.each([
    ["a plugin adds the declaration (no source names it)", () => false, false],
    ["only a constraint raises it", (group: string, name: string) => group === "g" && name === "d", true],
  ])("keeps the floor when %s", async (_, named, constraint) => {
    const brings: Brings = { "1.0": { x: "1.0" }, "1.1": { x: "2.0" } };
    const gradle = gradleOf("1.0", brings);
    const configuration = gradle.builds[0]!.configurations[0]!;
    const edges = constraint ? configuration.edges!.map((edge) => (edge.to.startsWith(X) ? { ...edge, constraint: true } : edge)) : configuration.edges!;
    const fixes = await withGradleParents([fixOf(X, "1.0", "GHSA-x")], {
      base: BASE, gradle: { ...gradle, builds: [{ build: ".", configurations: [{ ...configuration, edges }] }] }, named, inventories: references(brings),
      env: env(brings, { "g:x@1.0": ["GHSA-x"] }), config: parseConfig({}),
    });
    expect(fixes[0]?.notes).toEqual([expect.stringContaining("no declared dependency brings it")]);
  });
});
