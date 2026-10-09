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

async function named(files: Record<string, string>, coordinate: string, build = ".", builds = [build]) {
  const [group, name] = coordinate.split(":") as [string, string];
  return (await gradleSourceIndex(tree(files), builds)).named(build, group, name);
}

describe("gradleSourceIndex", () => {
  it.each([
    ["a string literal with a version", 'dependencies { implementation("com.acme:lib:1.0") }'],
    ["a string literal with a templated version", 'dependencies { implementation("com.acme:lib:$libVersion") }'],
    ["Groovy single quotes", "dependencies { implementation 'com.acme:lib:1.0' }"],
    ["named arguments", 'dependencies { implementation(group = "com.acme", name = "lib", version = "1.0") }'],
    ["a Groovy map", "dependencies { implementation group: 'com.acme', name: 'lib', version: '1.0' }"],
    ["named arguments, name first, another between", 'implementation(name = "lib", classifier = "x", group = "com.acme")'],
    ["named arguments with an expression between", "implementation(group: 'com.acme', version: libVersion, name: 'lib')"],
    ["named arguments over several lines", 'implementation(\n  group = "com.acme",\n  name = "lib",\n)'],
  ])("finds %s in a build script", async (_name, script) => {
    expect(await named({ "build.gradle.kts": script }, "com.acme:lib")).toBe(true);
  });

  it.each([
    ["a line comment", '// implementation("com.acme:lib:1.0")'],
    ["a block comment", '/*\n implementation("com.acme:lib:1.0")\n*/'],
    ["a longer name", 'implementation("com.acme:lib-extra:1.0")'],
    ["a longer group", 'implementation("com.acme.tools:lib:1.0")'],
    ["the Kotlin shorthand", 'implementation(kotlin("stdlib"))'],
    ["a nested block comment", '/* outer /* inner */ implementation("com.acme:lib:1.0") */'],
    ["group and name from two different maps", "def a = [group: 'com.acme', version: libVersion]; def b = [extra: true, name: 'lib']"],
    ["a project group beside another dependency's name", 'group = "com.acme"; dependencies { implementation(group = "org.other", name = "lib", version = "1.0") }'],
  ])("doesn't count %s", async (_name, script) => {
    expect(await named({ "build.gradle.kts": script }, "com.acme:lib")).toBe(false);
  });

  it("pairs group and name within their own argument list", async () => {
    const script = 'group = "com.acme"; dependencies { implementation(group = "org.other", name = "lib", version = "1.0") }';
    expect(await named({ "build.gradle.kts": script }, "org.other:lib")).toBe(true);
  });

  it("nests block comments only in Kotlin", async () => {
    const groovy = '/* Include files using src/* patterns. */\ndependencies { implementation "com.acme:lib:1.0" }';
    expect(await named({ "build.gradle": groovy }, "com.acme:lib")).toBe(true);
    expect(await named({ "buildSrc/src/main/java/Logic.java": groovy.replace("dependencies", "add") }, "com.acme:lib")).toBe(true);
    // In Kotlin the same `/*` opens a nested comment, so the whole rest is still inside it.
    expect(await named({ "build.gradle.kts": '/* a /* b */ implementation("com.acme:lib:1.0")' }, "com.acme:lib")).toBe(false);
  });

  it("reads past triple-quoted strings, backslashes included", async () => {
    const kotlin = 'val path = """C:\\tools\\"""\n// implementation("com.acme:commented:1.0")\nval doc = """implementation("com.acme:in-string:1.0") /* not a comment """\nimplementation("com.acme:lib:1.0")';
    const files = { "build.gradle.kts": kotlin };
    expect(await named(files, "com.acme:commented")).toBe(false);
    expect(await named(files, "com.acme:lib")).toBe(true);
    expect(await named({ "build.gradle": "def doc = \'\'\'it's /* not a comment\'\'\'\nimplementation 'com.acme:lib:1.0'" }, "com.acme:lib")).toBe(true);
    // Groovy escapes inside triple quotes: an escaped quote run doesn't end the string.
    const groovy = 'def doc = """a \\""" b // still text"""\n// implementation "com.acme:commented:1.0"\nimplementation "com.acme:lib:1.0"';
    expect(await named({ "build.gradle": groovy }, "com.acme:commented")).toBe(false);
    expect(await named({ "build.gradle": groovy }, "com.acme:lib")).toBe(true);
  });

  it("keeps code after a nested block comment", async () => {
    expect(await named({ "build.gradle.kts": '/* a /* b */ c */ implementation("com.acme:lib:1.0")' }, "com.acme:lib")).toBe(true);
  });

  it("keeps a URL in a string while dropping the comment after it", async () => {
    const script = 'repositories { maven("https://repo.example/maven") } // implementation("com.acme:lib:1.0")\nimplementation("com.acme:kept:1.0")';
    expect(await named({ "build.gradle.kts": script }, "com.acme:lib")).toBe(false);
    expect(await named({ "build.gradle.kts": script }, "com.acme:kept")).toBe(true);
  });

  it("reads the libraries of a version catalog, one entry at a time", async () => {
    const catalog = [
      "[versions]",
      'lib = "1.0"',
      "[libraries]",
      'literal = "com.acme:literal:1.0"',
      'moduled = { module = "com.acme:moduled", version.ref = "lib" }',
      'split = { group = "com.acme", name = "split", version.ref = "lib" } # a comment',
      'mixed-a = { group = "com.acme", name = "other" }',
      'mixed-b = { group = "org.other", name = "mixed" }',
      '# commented = "com.acme:commented:1.0"',
      "[plugins]",
      'plugin = { id = "com.acme.plugin", version = "1.0" }',
    ].join("\n");
    const files = { "gradle/libs.versions.toml": catalog };
    for (const coordinate of ["com.acme:literal", "com.acme:moduled", "com.acme:split"]) expect(await named(files, coordinate)).toBe(true);
    for (const coordinate of ["com.acme:mixed", "com.acme:commented", "com.acme:plugin"]) expect(await named(files, coordinate)).toBe(false);
  });

  it("reads the TOML forms catalog entries take", async () => {
    const catalog = [
      "[libraries]",
      '"quoted-key" = { module = "com.acme:quoted-key", version = "1.0" }',
      "single = { module = 'com.acme:single', version = '1.0' }",
      'literal-single = \'com.acme:literal-single:1.0\'',
      'dotted.module = "com.acme:dotted"',
      'dotted.version.ref = "x"',
      'nested = { group = "com.acme", name = "nested", version = { strictly = "[1.0, 2.0[", prefer = "1.5" } } # trailing',
      'rejecting = { version = { reject = ["1.1", "1,2]"], prefer = "1.3" }, module = "com.acme:rejecting" }',
      "[libraries.tabled]",
      'group = "com.acme"',
      'name = "tabled"',
      "[bundles]",
      "all = [",
      '  "quoted-key",',
      "]",
      "[plugins]",
      "'single-plugin' = { id = 'com.acme.single-plugin', version = '1.0' }",
    ].join("\n");
    const files = { "gradle/libs.versions.toml": catalog };
    for (const name of ["quoted-key", "single", "literal-single", "dotted", "nested", "rejecting", "tabled"]) expect(await named(files, `com.acme:${name}`)).toBe(true);
    expect(await named(files, "com.acme.single-plugin:com.acme.single-plugin.gradle.plugin")).toBe(true);
  });

  it("reads only the catalogs Gradle loads: the default one and the imported ones", async () => {
    const files = {
      "gradle/libs.versions.toml": '[libraries]\ndefault = "com.acme:default:1.0"',
      "gradle/tools.versions.toml": '[libraries]\nimported = "com.acme:imported:1.0"',
      "gradle/unused.versions.toml": "[libraries]\nbroken = { module = ",
      "settings.gradle.kts": 'dependencyResolutionManagement { versionCatalogs { create("tools") { from(files("gradle/tools.versions.toml")) } } }',
    };
    expect([await named(files, "com.acme:default"), await named(files, "com.acme:imported")]).toEqual([true, true]);
    const { "settings.gradle.kts": _settings, ...unimported } = files;
    expect(await named(unimported, "com.acme:imported")).toBe(false);
    // An import written inside a triple-quoted string is text, not a call: its broken catalog isn't read.
    for (const [settings, text] of [
      ["settings.gradle.kts", 'val example = """from(files("gradle/unused.versions.toml"))"""'],
      ["settings.gradle.kts", "val example = \"from(files('gradle/unused.versions.toml'))\""],
      ["settings.gradle", "def example = 'from files(\"gradle/unused.versions.toml\")'"],
      ["settings.gradle", 'def example = """a \\""" from(files("gradle/unused.versions.toml")) """'],
    ] as const) {
      expect(await named({ ...unimported, [settings]: text }, "com.acme:default")).toBe(true);
    }
  });

  it("decodes TOML escapes, and refuses a catalog Gradle couldn't read either", async () => {
    expect(await named({ "gradle/libs.versions.toml": '[libraries]\nlib = "com.acme:\\u006Cib:1.0"' }, "com.acme:lib")).toBe(true);
    await expect(named({ "gradle/libs.versions.toml": "[libraries]\nlib = { module = " }, "com.acme:lib")).rejects.toThrow("gradle/libs.versions.toml isn't a readable version catalog");
  });

  it("counts a catalog the build's settings import from elsewhere in the repository", async () => {
    const files = {
      "gradle/libs.versions.toml": '[libraries]\nshared = "com.acme:shared:1.0"',
      "buildSrc/settings.gradle.kts": 'dependencyResolutionManagement { versionCatalogs { create("libs") { from(files("../gradle/libs.versions.toml")) } } }',
      "outside/settings.gradle": "dependencyResolutionManagement { versionCatalogs { libs { from files('../../elsewhere/libs.versions.toml') } } }",
      // An absolute path isn't this repository's file, even when the repository has one at the joined path.
      "absolute/settings.gradle.kts": 'dependencyResolutionManagement { versionCatalogs { create("libs") { from(files("/tmp/libs.versions.toml")) } } }',
      "absolute/tmp/libs.versions.toml": '[libraries]\ncollision = "com.acme:collision:1.0"',
    };
    const index = await gradleSourceIndex(tree(files), ["buildSrc", "outside", "absolute"]);
    expect(index.named("buildSrc", "com.acme", "shared")).toBe(true);
    expect(index.named("outside", "com.acme", "shared")).toBe(false);
    expect(index.named("absolute", "com.acme", "collision")).toBe(false);
  });

  it("names a plugin's marker where a plugins block or a catalog plugin declares it", async () => {
    const marker = (id: string) => `${id}:${id}.gradle.plugin`;
    const files = {
      "build.gradle.kts": 'plugins {\n  id("com.acme.kts") version "1.0"\n  alias(libs.plugins.tabled)\n  `kotlin-dsl`\n}',
      "settings.gradle": "plugins { id 'com.acme.groovy' version '1.0' }",
      "gradle/libs.versions.toml": '[plugins]\ntabled = { id = "com.acme.tabled", version.ref = "x" }\nliteral = "com.acme.literal:1.0"\n[libraries]\nlib = "com.acme:lib:1.0"',
    };
    for (const id of ["com.acme.kts", "com.acme.groovy", "com.acme.tabled", "com.acme.literal"]) expect(await named(files, marker(id))).toBe(true);
    // A library coordinate isn't a plugin, and the backtick shorthand isn't read.
    expect(await named(files, marker("com.acme"))).toBe(false);
    expect(await named(files, marker("org.gradle.kotlin.kotlin-dsl"))).toBe(false);
  });

  it("gives each build its own files, with buildSrc and build-logic main code counting for the build they serve", async () => {
    const files = {
      "settings.gradle.kts": 'includeBuild("included")',
      "build.gradle.kts": 'implementation("com.acme:root:1.0")',
      "buildSrc/src/main/kotlin/conventions.gradle.kts": 'dependencies { add("implementation", "com.acme:convention:1.0") }',
      "buildSrc/src/test/kotlin/ConventionsTest.kt": 'val fixture = "com.acme:test-only:1.0"',
      "build-logic/plugins/src/main/java/Logic.java": 'project.getDependencies().add("implementation", "com.acme:logic:1.0");',
      "included/build.gradle.kts": 'implementation("com.acme:included:1.0")',
      "src/main/kotlin/shipped.gradle.kts": 'dependencies { implementation("com.acme:shipped:1.0") }',
      "src/app/build.gradle": "dependencies { implementation 'com.acme:src-project:1.0' }",
      "build/generated/leftover.gradle.kts": 'implementation("com.acme:generated:1.0")',
    };
    const builds = [".", "buildSrc", "included"];
    const index = await gradleSourceIndex(tree(files), builds);
    const at = (build: string, name: string) => index.named(build, "com.acme", name);
    expect([at(".", "root"), at(".", "convention"), at(".", "logic"), at(".", "src-project")]).toEqual([true, true, true, true]);
    expect([at(".", "included"), at(".", "test-only"), at(".", "shipped"), at(".", "generated")]).toEqual([false, false, false, false]);
    expect([at("included", "included"), at("included", "root")]).toEqual([true, false]);
    expect(() => index.named("missing", "com.acme", "root")).toThrow("no source index");
  });
});
