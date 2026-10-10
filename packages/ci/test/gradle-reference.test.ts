/**
 * The reference init script under real Gradle (the pinned wrapper, a local file repository of POM-only modules): a
 * plan applied by Gradle moves declarations in place, keeping a strict version strict, reaches the buildscript
 * classpath, adds floors next to a configuration's defaults, and moves a declaration wherever it's inherited (what
 * the tools then check the plan lists). Needs a JDK; runs when SUPPLY_CHAIN_GRADLE_TESTS=1.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gradleLocation, type GradleInventory, runGradleInventory } from "../src/gradle.ts";
import { runProcess } from "../src/process.ts";

const WRAPPER = fileURLToPath(new URL("./fixtures/gradle-wrapper", import.meta.url));
const REFERENCE = fileURLToPath(new URL("../gradle/supply-chain-reference.init.gradle", import.meta.url));

/** group:artifact:version → its dependencies, each a POM-only module. */
const MODULES: Record<string, string[]> = {
  "fixture:plain:1.0": ["fixture:transitive:1.0"],
  "fixture:plain:2.0": ["fixture:transitive:1.0"],
  "fixture:transitive:1.0": [],
  "fixture:transitive:2.0": [],
  "fixture:strict:1.0": [],
  "fixture:strict:2.0": [],
  "fixture:strict:3.0": [],
  "fixture:wants-strict:1.0": ["fixture:strict:3.0"],
  "fixture:classpath-dep:1.0": [],
  "fixture:classpath-dep:2.0": [],
  "fixture:defaulted:1.0": [],
  "fixture:defaulted-extra:1.0": [],
};
const IMPLEMENTATION = [":compileClasspath", ":runtimeClasspath", ":testCompileClasspath", ":testRuntimeClasspath"];

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

let root: string;
let build: string;

async function reference(plan: { moves?: unknown[]; floors?: unknown[] }): Promise<GradleInventory> {
  const file = join(root, `plan-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify({ repositoryRoot: build, moves: plan.moves ?? [], floors: plan.floors ?? [] }));
  return runGradleInventory(build, ["."], "worktree", runProcess, { additionalInitScripts: [REFERENCE], systemProperties: { "supplyChain.reference.file": file } });
}

function at(inventory: GradleInventory, location: string) {
  const found = inventory.builds.flatMap((entry) => entry.configurations.map((configuration) => ({ location: gradleLocation(entry.build, configuration.id), configuration })))
    .find((entry) => entry.location === location)?.configuration;
  if (found === undefined) throw new Error(`no ${location}`);
  return {
    resolved: found.resolved.map((module) => `${module.name}:${module.version}`).sort(),
    declared: found.declared.map((declared) => `${declared.name}:${declared.version}`).sort(),
    error: found.error,
  };
}

describe.skipIf(process.env["SUPPLY_CHAIN_GRADLE_TESTS"] !== "1")("Gradle reference", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "supply-chain-gradle-reference-"));
    const repo = join(root, "repo");
    for (const [coordinates, dependencies] of Object.entries(MODULES)) {
      const [group, artifact, version] = coordinates.split(":");
      await write(repo, `${group!.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`, pom(coordinates, dependencies));
    }
    build = join(root, "build");
    await cp(WRAPPER, build, { recursive: true });
    const repository = `repositories { maven { url = uri("${repo}") } }`;
    await write(build, "settings.gradle", `rootProject.name = "fixture"\n`);
    await write(build, "build.gradle", `buildscript {
  ${repository}
  dependencies { classpath "fixture:classpath-dep:1.0" }
}
plugins { id "java" }
${repository}
configurations { defaulted { defaultDependencies { it.add(project.dependencies.create("fixture:defaulted:1.0")) } } }
dependencies {
  implementation "fixture:plain:1.0"
  implementation("fixture:strict") { version { strictly "1.0" } }
  implementation "fixture:wants-strict:1.0"
}
`);
  }, 600_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("moves declarations in place, a strict version staying strict, on the buildscript classpath too", async () => {
    const inventory = await reference({ moves: [
      { name: "fixture:plain", from: "1.0", to: "2.0", locations: IMPLEMENTATION },
      { name: "fixture:strict", from: "1.0", to: "2.0", locations: IMPLEMENTATION },
      { name: "fixture:classpath-dep", from: "1.0", to: "2.0", locations: [":buildscript.classpath"] },
    ] });
    for (const location of IMPLEMENTATION) {
      // wants-strict asks for strict 3.0: still strictly 2.0 after the move.
      expect(at(inventory, location)).toMatchObject({ resolved: ["plain:2.0", "strict:2.0", "transitive:1.0", "wants-strict:1.0"], declared: ["plain:2.0", "strict:2.0", "wants-strict:1.0"], error: undefined });
    }
    expect(at(inventory, ":buildscript.classpath")).toMatchObject({ resolved: ["classpath-dep:2.0"], declared: ["classpath-dep:2.0"] });
  }, 600_000);

  it("adds floors through a parent, next to a configuration's defaults", async () => {
    const inventory = await reference({ floors: [
      { name: "fixture:transitive", version: "2.0", reason: "GHSA-test", locations: [":runtimeClasspath"] },
      { name: "fixture:defaulted-extra", version: "1.0", reason: "GHSA-test", locations: [":defaulted"] },
    ] });
    expect(at(inventory, ":runtimeClasspath")).toMatchObject({ resolved: expect.arrayContaining(["transitive:2.0"]), declared: expect.arrayContaining(["transitive:2.0"]) });
    expect(at(inventory, ":compileClasspath").resolved).toContain("transitive:1.0");
    expect(at(inventory, ":defaulted")).toMatchObject({ resolved: ["defaulted-extra:1.0", "defaulted:1.0"], declared: ["defaulted-extra:1.0", "defaulted:1.0"] });
  }, 600_000);

  it("marks a moved declaration wherever it's inherited, at a configuration the plan doesn't list too, its reason untouched", async () => {
    const inventory = await reference({ moves: [{ name: "fixture:plain", from: "1.0", to: "2.0", locations: [":runtimeClasspath"] }] });
    const plain = (location: string) => inventory.builds[0]!.configurations.find((configuration) => configuration.id === location)!.declared.filter((declared) => declared.name === "plain");
    for (const location of [":runtimeClasspath", ":compileClasspath"]) expect(plain(location)).toEqual([{ group: "fixture", name: "plain", version: "2.0", reason: undefined, moved: true }]);
  }, 600_000);
});
