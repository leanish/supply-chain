import { describe, expect, it } from "vitest";

import { gradleSourceIndex } from "../src/gradle-sources.ts";
import type { Tree } from "../src/tree.ts";

function tree(files: Record<string, string>): Tree {
  return {
    id: "fixture",
    read: async (path) => files[path],
    list: async (dir) => Object.keys(files).filter((path) => dir === "." || path.startsWith(`${dir}/`)).sort(),
  };
}

async function named(files: Record<string, string>, coordinate: string) {
  const [group, name] = coordinate.split(":") as [string, string];
  return (await gradleSourceIndex(tree(files))).named(group, name);
}

const marker = (id: string) => `${id}:${id}.gradle.plugin`;

describe("gradleSourceIndex", () => {
  it.each([
    ["a string literal with a version", 'dependencies { implementation("com.acme:lib:1.0") }'],
    ["a string literal without one", 'dependencies { implementation("com.acme:lib") }'],
    ["a templated version with spaces", 'implementation("com.acme:lib:${libVersion ?: defaultVersion}")'],
    ["Groovy single quotes", "dependencies { implementation 'com.acme:lib:1.0' }"],
    ["named arguments, in any order", 'implementation(name = "lib", classifier = "x", group = "com.acme")'],
    ["a Groovy map over several lines", "implementation group: 'com.acme',\n  version: libVersion,\n  name: 'lib'"],
    ["a comment", '// implementation("com.acme:lib:1.0")'],
    ["a string after a stray apostrophe", '// it\'s pinned "com.acme:lib:1.0"'],
  ])("finds %s", async (_name, script) => {
    expect(await named({ "build.gradle.kts": script }, "com.acme:lib")).toBe(true);
  });

  it.each([
    ["a longer name", 'implementation("com.acme:lib-extra:1.0")'],
    ["a longer group", 'implementation("com.acme.tools:lib:1.0")'],
    ["the Kotlin shorthand", 'implementation(kotlin("stdlib"))'],
    ["the group alone", 'implementation(group = "com.acme", name = libName)'],
  ])("doesn't take %s for it", async (_name, script) => {
    expect(await named({ "build.gradle.kts": script }, "com.acme:lib")).toBe(false);
  });

  it("names group and name quoted in one file, never across files", async () => {
    expect(await named({ "a/build.gradle": "def g = 'com.acme'", "b/build.gradle": "def n = 'lib'" }, "com.acme:lib")).toBe(false);
    expect(await named({ "build.gradle": "def g = 'com.acme'\ndef n = 'lib'" }, "com.acme:lib")).toBe(true);
  });

  it("reads the whole repository: every build, buildSrc and build-logic code, build output, catalogs anywhere", async () => {
    const files = {
      "settings.gradle.kts": 'includeBuild("tools")',
      "tools/app/build.gradle.kts": 'implementation("com.acme:nested:1.0")',
      "buildSrc/src/main/kotlin/Conventions.kt": 'add("implementation", "com.acme:convention:1.0")',
      "build-logic/src/main/kotlin/odd\nname/Logic.kt": 'add("implementation", "com.acme:odd:1.0")',
      "build-logic/src/main/kotlin/acme.gradle.kts": 'plugins { id("com.acme.precompiled") }',
      "out/tools/build.gradle": "implementation 'com.acme:out:1.0'",
      "src/main/kotlin/shipped.gradle.kts": 'dependencies { "implementation"("com.acme:shipped:1.0") }',
      "deps/other.toml": '[libraries]\nlib = { module = "com.acme:imported" }',
      "src/main/java/App.java": 'String s = "com.acme:application:1.0";',
    };
    for (const coordinate of ["com.acme:nested", "com.acme:convention", "com.acme:odd", marker("com.acme.precompiled"), "com.acme:out", "com.acme:shipped", "com.acme:imported"]) {
      expect(await named(files, coordinate), coordinate).toBe(true);
    }
    // Application code isn't a build source.
    expect(await named(files, "com.acme:application")).toBe(false);
  });

  it("reads the TOML forms catalog entries take, escapes decoded", async () => {
    const catalog = [
      "[libraries]",
      '"quoted-key" = { module = "com.acme:quoted-key", version = "1.0" }',
      "literal-single = 'com.acme:literal-single:1.0'",
      'dotted.module = "com.acme:dotted"',
      'split = { group = "com.acme", name = "split", version = { strictly = "[1.0, 2.0[" } }',
      'escaped = "com\\u002eacme:escaped:1.0"',
      "[libraries.tabled]",
      'group = "com.acme"',
      'name = "tabled"',
      "[plugins]",
      "single = { id = 'com.acme.single-plugin', version = '1.0' }",
      'literal = "com.acme.literal:1.0"',
    ].join("\n");
    const files = { "gradle/libs.versions.toml": catalog };
    for (const name of ["quoted-key", "literal-single", "dotted", "split", "escaped", "tabled"]) expect(await named(files, `com.acme:${name}`), name).toBe(true);
    for (const id of ["com.acme.single-plugin", "com.acme.literal"]) expect(await named(files, marker(id)), id).toBe(true);
  });

  it("still reads the raw text of a TOML file that doesn't parse", async () => {
    expect(await named({ "gradle/libs.versions.toml": '[libraries]\nlib = "com.acme:lib:1.0"\n[libraries]' }, "com.acme:lib")).toBe(true);
  });

  it("names a plugin's marker by its id quoted whole or before a colon", async () => {
    const files = {
      "build.gradle.kts": 'plugins {\n  id /* why */ ("com.acme.kts") version "1.0"\n  `kotlin-dsl`\n}\napply(plugin = "com.acme.applied")',
      "settings.gradle": "plugins { id 'com.acme.groovy' version '1.0' }\nbuildscript { dependencies { classpath 'com.acme.classpath:com.acme.classpath.gradle.plugin:1.0' } }",
      "deps.toml": 'plugin = "com.acme.literal:1.0"',
    };
    for (const id of ["com.acme.kts", "com.acme.applied", "com.acme.groovy", "com.acme.classpath", "com.acme.literal"]) expect(await named(files, marker(id)), id).toBe(true);
    // The backtick shorthand isn't read, nor a longer id.
    expect(await named(files, marker("org.gradle.kotlin.kotlin-dsl"))).toBe(false);
    expect(await named(files, marker("com.acme"))).toBe(false);
  });
});
