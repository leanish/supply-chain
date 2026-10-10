import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SecurityFix } from "../../ci/src/candidates.ts";
import { parseConfig } from "../../ci/src/config.ts";
import type { GateEnvironment } from "../../ci/src/gate.ts";
import { type GradleInventory, runGradleInventory } from "../../ci/src/gradle.ts";
import { gradleSourceIndex } from "../../ci/src/gradle-sources.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import { workingTree } from "../../ci/src/tree.ts";
import { fakeFetch } from "../../ci/test/fake-fetch.ts";
import type { GradleTransform } from "../../remediation/src/inventories.ts";
import { withGradleParents } from "../src/gradle-parents.ts";
import { planFor } from "../src/plan.ts";

const WRAPPER = fileURLToPath(new URL("../../ci/test/fixtures/gradle-wrapper", import.meta.url));
const CENTRAL = "https://repo1.maven.org/maven2";

/** group:artifact:version → its dependencies, each a POM-only module: d's versions bring x 1.0, 1.5 and 2.0. */
const MODULES: Record<string, string[]> = {
  "fixture:d:1.0": ["fixture:x:1.0"],
  "fixture:d:1.1": ["fixture:x:1.5"],
  "fixture:d:1.2": ["fixture:x:2.0"],
  "fixture:x:1.0": [],
  "fixture:x:1.5": [],
  "fixture:x:2.0": [],
};
/** x below 2.0 has the advisory. */
const AFFECTED: Record<string, string[]> = { "fixture:x@1.0": ["GHSA-x"], "fixture:x@1.5": ["GHSA-x"] };

function pom(coordinates: string, dependencies: string[]): string {
  const [group, artifact, version] = coordinates.split(":");
  const deps = dependencies.map((dependency) => {
    const [g, a, v] = dependency.split(":");
    return `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version></dependency>`;
  }).join("");
  return `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version><packaging>pom</packaging><dependencies>${deps}</dependencies></project>`;
}

async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** Fake osv-scanner from AFFECTED; d's versions listed and dated (all aged) as Maven Central would. */
function environment(): GateEnvironment {
  const run: RunProcess = async (command, args, options) => {
    if (command !== "osv-scanner") return runProcess(command, args, options);
    if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
    const inventory = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
      results: Array<{ packages: Array<{ package: { name: string; version: string; ecosystem: string } }> }>;
    };
    const packages = inventory.results[0]!.packages.map(({ package: pkg }) => ({
      package: pkg, vulnerabilities: (AFFECTED[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id, summary: id })),
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
  const routes: Parameters<typeof fakeFetch>[0] = {
    [`${CENTRAL}/fixture/d/maven-metadata.xml`]: { text: "<metadata><versioning><versions><version>1.0</version><version>1.1</version><version>1.2</version></versions></versioning></metadata>" },
  };
  for (const coordinates of Object.keys(MODULES)) {
    const [, artifact, version] = coordinates.split(":");
    routes[`${CENTRAL}/fixture/${artifact}/${version}/${artifact}-${version}.pom`] = { headers: { "last-modified": "Mon, 01 Jun 2026 00:00:00 GMT" }, text: "<project></project>" };
  }
  return { run, fetch: fakeFetch(routes), now: () => new Date("2026-10-10T12:00:00Z"), osvScanner: "osv-scanner", githubToken: undefined };
}

let root: string;
let build: string;

describe.skipIf(process.env["SUPPLY_CHAIN_GRADLE_TESTS"] !== "1")("Gradle parents, with real Gradle", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "secure-it-gradle-parents-"));
    const repo = join(root, "repo");
    for (const [coordinates, dependencies] of Object.entries(MODULES)) {
      const [group, artifact, version] = coordinates.split(":");
      await write(repo, `${group!.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`, pom(coordinates, dependencies));
    }
    build = join(root, "build");
    await cp(WRAPPER, build, { recursive: true });
    await write(build, "settings.gradle", `rootProject.name = "fixture"\n`);
    await write(build, "build.gradle", `plugins { id "java" }
repositories { maven { url = uri("${repo}") } }
dependencies { implementation "fixture:d:1.0" }
`);
  }, 600_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("proves d's versions with real reference resolutions and moves it to the first that brings a fixed x", async () => {
    const base = await runGradleInventory(build, ["."], "worktree", runProcess);
    const probes: string[] = [];
    // The tool's reference resolution, run unsandboxed on the fixture build.
    const inventories = {
      ofCommit: async (_tree: unknown, change?: { readonly transform?: GradleTransform }): Promise<GradleInventory> => {
        const transform = change!.transform!;
        const plan = join(root, `plan-${probes.length}.json`);
        const content = transform.content(build) as { moves: Array<{ to: string }> };
        probes.push(content.moves[0]!.to);
        await writeFile(plan, JSON.stringify(content));
        return runGradleInventory(build, ["."], "worktree", runProcess, { additionalInitScripts: [transform.initScript], systemProperties: { [transform.property]: plan } });
      },
    };
    const tree = workingTree(build);
    const { named } = await gradleSourceIndex(tree);
    const fix: SecurityFix = {
      ecosystem: "Maven", name: "fixture:x", from: "1.0", locations: [":compileClasspath", ":runtimeClasspath", ":testCompileClasspath", ":testRuntimeClasspath"],
      targets: ["GHSA-x"], unfixable: [], malicious: false, severity: "HIGH", to: { version: "2.0", line: "2", aged: true, major: true, blockers: [] }, problem: undefined,
    };
    const fixes = await withGradleParents([fix], { base: tree, gradle: base, named, inventories, env: environment(), config: parseConfig({}) });
    expect(probes).toEqual(["1.1", "1.2"]);
    const plan = await planFor(fixes, { named, lockfiles: new Map(), gradle: base, tagCommit: async () => undefined });
    expect(plan.moves).toEqual([expect.objectContaining({
      name: "fixture:d", from: "1.0", to: "1.2", mechanism: "gradle-declared",
      carries: [expect.objectContaining({ name: "fixture:x", from: ["1.0"], to: ["2.0"] })],
    })]);
  }, 600_000);
});
