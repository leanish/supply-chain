/**
 * The Gradle adapter's coverage proof: a real Gradle run (the pinned wrapper,
 * a local file repository of POM-only modules, no network beyond the wrapper's
 * own distribution) over a build that puts dependencies everywhere they can
 * hide. Needs a JDK; runs when SUPPLY_CHAIN_GRADLE_TESTS=1.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gradleLocated, gradleResolutionProblems, type GradleInventory, parseGradleInventory, runGradleInventory } from "../src/gradle.ts";
import { runProcess } from "../src/process.ts";

const WRAPPER = fileURLToPath(new URL("./fixtures/gradle-wrapper", import.meta.url));

/** group:artifact:version → its dependencies, each a POM-only module. */
const MODULES: Record<string, string[]> = {
  "fixture:runtime-lib:1.0": ["fixture:transitive:2.0"],
  "fixture:transitive:2.0": [],
  "fixture:floored:2.0": [],
  "fixture:test-lib:1.0": [],
  "fixture:processor:1.0": [],
  "fixture:tool:1.0": ["fixture:tool-transitive:3.0"],
  "fixture:tool-transitive:3.0": [],
  "fixture:buildscript-dep:1.0": [],
  "fixture:settings-dep:1.0": [],
  "fixture.plugin:fixture.plugin.gradle.plugin:1.0": ["fixture:plugin-impl:1.0"],
  "fixture:plugin-impl:1.0": ["fixture:plugin-transitive:1.0"],
  "fixture:plugin-transitive:1.0": [],
  "fixture:sub-runtime:1.0": [],
  "fixture:buildsrc-dep:1.0": [],
  "fixture:included-dep:1.0": [],
  "fixture:plugin-build-dep:1.0": [],
  "fixture:ab-colon:1.0": [],
  "fixture:ab-underscore:1.0": [],
};

function pom(coordinates: string, dependencies: string[]): string {
  const [group, artifact, version] = coordinates.split(":");
  const deps = dependencies
    .map((dependency) => {
      const [g, a, v] = dependency.split(":");
      return `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version></dependency>`;
    })
    .join("");
  return `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version><packaging>pom</packaging><dependencies>${deps}</dependencies></project>`;
}

async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

let root: string;
let inventory: GradleInventory;

describe.skipIf(process.env["SUPPLY_CHAIN_GRADLE_TESTS"] !== "1")("Gradle inventory coverage", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "supply-chain-gradle-fixture-"));
    const repo = join(root, "repo");
    for (const [coordinates, dependencies] of Object.entries(MODULES)) {
      const [group, artifact, version] = coordinates.split(":");
      await write(repo, `${group!.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`, pom(coordinates, dependencies));
    }
    const build = join(root, "build");
    await cp(WRAPPER, build, { recursive: true });
    const repository = `repositories { maven { url = uri("${repo}") } }`;
    // A settings plugin from an included plugin build: that build is evaluated before the root's settings finish.
    await write(build, "settings.gradle", `pluginManagement {
  includeBuild("build-logic")
  ${repository}
}
buildscript {
  ${repository}
  dependencies { classpath "fixture:settings-dep:1.0" }
}
plugins { id "fixture.settings" }
rootProject.name = "fixture"
include "sub", "a:b", "a_b"
includeBuild "included"
`);
    await write(build, "build-logic/settings.gradle", `rootProject.name = "build-logic"\n`);
    await write(build, "build-logic/build.gradle", `plugins { id "java-gradle-plugin" }
${repository}
dependencies { implementation "fixture:plugin-build-dep:1.0" }
gradlePlugin { plugins { settingsPlugin { id = "fixture.settings"; implementationClass = "fixture.SettingsPlugin" } } }
`);
    await write(build, "build-logic/src/main/java/fixture/SettingsPlugin.java", `package fixture;
public class SettingsPlugin implements org.gradle.api.Plugin<org.gradle.api.initialization.Settings> {
  public void apply(org.gradle.api.initialization.Settings settings) {}
}
`);
    // Two projects whose paths once mapped to the same file name.
    await write(build, "a/b/build.gradle", `plugins { id "java" }\n${repository}\ndependencies { implementation "fixture:ab-colon:1.0" }\n`);
    await write(build, "a_b/build.gradle", `plugins { id "java" }\n${repository}\ndependencies { implementation "fixture:ab-underscore:1.0" }\n`);
    await write(build, "build.gradle", `buildscript {
  ${repository}
  dependencies { classpath "fixture:buildscript-dep:1.0" }
}
plugins { id "java" }
${repository}
configurations { tool }
dependencies {
  implementation "fixture:runtime-lib:1.0"
  implementation("fixture:floored:2.0") { because "GHSA-test-floor: lowest fixed version" }
  testImplementation "fixture:test-lib:1.0"
  annotationProcessor "fixture:processor:1.0"
  tool "fixture:tool:1.0"
}
`);
    await write(build, "sub/build.gradle", `plugins {
  id "java"
  id "fixture.plugin" version "1.0" apply false
}
${repository}
dependencies { runtimeOnly "fixture:sub-runtime:1.0" }
`);
    await write(build, "buildSrc/build.gradle", `plugins { id "java" }
${repository}
dependencies { implementation "fixture:buildsrc-dep:1.0" }
`);
    await write(build, "included/settings.gradle", `rootProject.name = "included"\n`);
    await write(build, "included/build.gradle", `plugins { id "java" }
${repository}
dependencies { implementation "fixture:included-dep:1.0" }
`);
    inventory = await runGradleInventory(build, [".", "included"], "worktree", runProcess);
  }, 600_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const locations = (coordinates: string) => {
    const [group, artifact, version] = coordinates.split(":");
    return gradleLocated(inventory).find((pkg) => pkg.name === `${group}:${artifact}` && pkg.version === version)?.locations ?? [];
  };

  it("covers runtime, transitive, test, annotation-processor and tool dependencies", () => {
    expect(locations("fixture:runtime-lib:1.0")).toEqual(expect.arrayContaining([":compileClasspath", ":runtimeClasspath", ":testRuntimeClasspath"]));
    expect(locations("fixture:transitive:2.0")).toEqual(expect.arrayContaining([":runtimeClasspath"]));
    expect(locations("fixture:test-lib:1.0")).toEqual(expect.arrayContaining([":testCompileClasspath", ":testRuntimeClasspath"]));
    expect(locations("fixture:processor:1.0")).toEqual([":annotationProcessor"]);
    expect(locations("fixture:tool:1.0")).toEqual([":tool"]);
    expect(locations("fixture:tool-transitive:3.0")).toEqual([":tool"]);
    expect(locations("fixture:sub-runtime:1.0")).toEqual(expect.arrayContaining([":sub:runtimeClasspath"]));
  });

  it("covers the buildscript, plugins DSL and settings classpaths", () => {
    expect(locations("fixture:buildscript-dep:1.0")).toEqual([":buildscript.classpath"]);
    expect(locations("fixture:plugin-impl:1.0")).toEqual([":sub:buildscript.classpath"]);
    expect(locations("fixture:plugin-transitive:1.0")).toEqual([":sub:buildscript.classpath"]);
    expect(locations("fixture.plugin:fixture.plugin.gradle.plugin:1.0")).toEqual([":sub:buildscript.classpath"]);
    expect(locations("fixture:settings-dep:1.0")).toEqual(["settings.classpath"]);
  });

  it("covers buildSrc, included and plugin builds, under their own location prefix", () => {
    expect(inventory.builds.map((build) => build.build).sort()).toEqual([".", "build-logic", "buildSrc", "included"]);
    expect(locations("fixture:plugin-build-dep:1.0")).toEqual(expect.arrayContaining(["build-logic/:runtimeClasspath"]));
    expect(locations("fixture:buildsrc-dep:1.0")).toEqual(expect.arrayContaining(["buildSrc/:compileClasspath", "buildSrc/:runtimeClasspath"]));
    expect(locations("fixture:included-dep:1.0")).toEqual(expect.arrayContaining(["included/:runtimeClasspath"]));
  });

  it("exports declared dependencies, inherited ones included, with their because(...) reason", () => {
    const declared = inventory.builds
      .find((build) => build.build === ".")!
      .configurations.flatMap((configuration) => configuration.declared.map((dependency) => ({ id: configuration.id, ...dependency })))
      .filter((dependency) => dependency.name === "floored");
    expect(declared.map((dependency) => dependency.id).sort()).toEqual([
      ":compileClasspath",
      ":runtimeClasspath",
      ":testCompileClasspath",
      ":testRuntimeClasspath",
    ]);
    expect(declared[0]).toMatchObject({ group: "fixture", version: "2.0", reason: "GHSA-test-floor: lowest fixed version" });
    expect(gradleResolutionProblems(inventory, [])).toEqual([]);
  });

  it("keeps projects apart whose paths look alike", () => {
    expect(locations("fixture:ab-colon:1.0")).toEqual(expect.arrayContaining([":a:b:runtimeClasspath"]));
    expect(locations("fixture:ab-underscore:1.0")).toEqual(expect.arrayContaining([":a_b:runtimeClasspath"]));
  });

  it("inventories included builds Gradle configures from the root build without listing them, in a form compare accepts", async () => {
    // A relative path, as the workflow passes it (`--repo repo`).
    const rootOnly = await runGradleInventory(relative(process.cwd(), join(root, "build")), ["."], "worktree", runProcess);
    expect(rootOnly.builds.map((build) => build.build).sort()).toEqual([".", "build-logic", "buildSrc", "included"]);
    // What `gradle-inventory` writes, read back as `compare` reads it, against the default sources.
    const reread = parseGradleInventory(JSON.parse(JSON.stringify(rootOnly)), "worktree", ["."]);
    expect(gradleLocated(reread)).toEqual(gradleLocated(rootOnly));
  }, 600_000);

  it("reports a dependency that doesn't resolve", async () => {
    await write(join(root, "build"), "sub/build.gradle", `plugins { id "java" }
repositories { maven { url = uri("${join(root, "repo")}") } }
dependencies { runtimeOnly "fixture:missing:9.9" }
`);
    const broken = await runGradleInventory(join(root, "build"), ["."], "worktree", runProcess);
    expect(gradleResolutionProblems(broken, [])).toEqual([
      expect.stringMatching(/^Gradle :sub:runtimeClasspath couldn't resolve fixture:missing:9.9: /),
      expect.stringMatching(/^Gradle :sub:testRuntimeClasspath couldn't resolve fixture:missing:9.9: /),
    ]);
    expect(gradleResolutionProblems(broken, [":sub:runtimeClasspath", ":sub:testRuntimeClasspath"])).toEqual([]);
  }, 600_000);
});
