import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isOwnPackage, parseConfig } from "../src/config.ts";
import { gradleLocated, gradleResolutionProblems, parseGradleInventory, runGradleInventory } from "../src/gradle.ts";
import { MavenDates, mavenChangeProblems } from "../src/maven-changes.ts";
import { parseExceptions, NO_EXCEPTIONS } from "../src/exceptions.ts";
import type { Located } from "../src/findings.ts";
import type { RunProcess } from "../src/process.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";
import { fakeFetch } from "./fake-fetch.ts";

const NOW = new Date("2026-10-06T12:00:00Z");

const configuration = (id: string, resolved: string[], extra: object = {}) => ({
  id,
  kind: "project",
  resolved: resolved.map((coordinates) => {
    const [group, name, version] = coordinates.split(":");
    return { group, name, version };
  }),
  unresolved: [],
  declared: [],
  error: null,
  ...extra,
});

describe("Gradle inventory files", () => {
  const valid = {
    schemaVersion: 1,
    tree: "abc123",
    builds: [{ build: ".", configurations: [configuration(":runtimeClasspath", ["com.acme:lib:1.0"])] }],
  };

  it("reads a valid inventory and locates its modules", () => {
    const inventory = parseGradleInventory(valid, "abc123", ["."]);
    expect(gradleLocated(inventory)).toEqual([{ ecosystem: "Maven", name: "com.acme:lib", version: "1.0", locations: [":runtimeClasspath"] }]);
  });

  it("rejects another commit, other builds, other schemas and malformed entries", () => {
    expect(() => parseGradleInventory(valid, "def456", ["."])).toThrow("made from abc123, not def456");
    expect(() => parseGradleInventory(valid, "abc123", [".", "build-logic"])).toThrow("covers builds ., missing build-logic from supply-chain.json");
    expect(parseGradleInventory({ ...valid, builds: [...valid.builds, { build: "buildSrc", configurations: [] }] }, "abc123", ["."]).builds).toHaveLength(2);
    expect(() => parseGradleInventory({ ...valid, builds: [...valid.builds, ...valid.builds] }, "abc123", ["."])).toThrow("lists a build twice");
    expect(() => parseGradleInventory({ ...valid, schemaVersion: 2 }, "abc123", ["."])).toThrow("schemaVersion must be 1");
    const broken = (config: object) => ({ ...valid, builds: [{ build: ".", configurations: [config] }] });
    expect(() => parseGradleInventory(broken({ id: ":x", kind: "weird" }), "abc123", ["."])).toThrow("malformed configuration");
    expect(() => parseGradleInventory(broken(configuration(":x", ["com.acme:lib:"])), "abc123", ["."])).toThrow("malformed version");
    expect(() => parseGradleInventory(broken({ ...configuration(":x", []), resolved: "all" }), "abc123", ["."])).toThrow(":x.resolved must be a list");
  });

  it("names configurations of other builds by their directory, and reports resolution failures unless ignored", () => {
    const inventory = parseGradleInventory(
      {
        schemaVersion: 1,
        tree: "abc123",
        builds: [
          { build: ".", configurations: [configuration(":runtimeClasspath", [], { unresolved: [{ requested: "com.acme:gone:1.0", failure: "not found" }] })] },
          { build: "buildSrc", configurations: [configuration(":compileClasspath", ["com.acme:lib:1.0"], { error: "boom" })] },
        ],
      },
      "abc123",
      ["."],
    );
    expect(gradleLocated(inventory)[0]!.locations).toEqual(["buildSrc/:compileClasspath"]);
    expect(gradleResolutionProblems(inventory, [])).toEqual([
      "Gradle :runtimeClasspath couldn't resolve com.acme:gone:1.0: not found",
      "Gradle buildSrc/:compileClasspath didn't resolve: boom",
    ]);
    expect(gradleResolutionProblems(inventory, ["buildSrc/:compileClasspath"])).toHaveLength(1);
  });
});

describe("running the Gradle inventory", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "supply-chain-gradle-run-"));
    await writeFile(join(repo, "gradlew"), "");
    await writeFile(join(repo, "settings.gradle.kts"), `rootProject.name = "x"\nincludeBuild("tools/conventions")\n`);
    await mkdir(join(repo, "tools/conventions"), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /**
   * A fake gradlew writing outputs for `builds` (labels relative to the requested build): one project
   * each, plus a manifest listing `nested` as the root build's nested builds.
   */
  function gradlew(builds: string[], calls: string[][] = [], nested: string[] = ["tools/conventions"]): RunProcess {
    return async (_command, args) => {
      calls.push([...args]);
      const out = args.find((arg) => arg.startsWith("-DsupplyChain.out="))!.slice("-DsupplyChain.out=".length);
      for (const build of builds) {
        const file = (project: string) => join(out, `${encodeURIComponent(`${build}|${project}`)}.json`);
        await writeFile(file(":"), JSON.stringify({ schemaVersion: 1, build, project: ":", configurations: [configuration(":runtimeClasspath", [])] }));
        const requested = args[args.indexOf("-p") + 1];
        const manifest = { projects: [":"], nestedBuilds: build === "." && requested === "." ? nested : [] };
        await writeFile(file("manifest"), JSON.stringify({ schemaVersion: 1, build, project: "manifest", manifest }));
        await writeFile(file("settings"), JSON.stringify({ schemaVersion: 1, build, project: "settings", configurations: [] }));
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  it("collects nested builds the run configured, and fails on one Gradle's model lists that's missing", async () => {
    const calls: string[][] = [];
    const inventory = await runGradleInventory(repo, ["."], "worktree", gradlew([".", "tools/conventions"], calls));
    expect(inventory.builds.map((build) => build.build)).toEqual([".", "tools/conventions"]);
    expect(calls[0]).toEqual(expect.arrayContaining(["-p", ".", "--no-configuration-cache", "supplyChainInventory"]));
    await expect(runGradleInventory(repo, ["."], "worktree", gradlew(["."]))).rejects.toThrow(
      "Gradle builds that weren't inventoried (list them in supply-chain.json gradle.builds): tools/conventions",
    );
    const listed = await runGradleInventory(repo, [".", "tools/conventions"], "worktree", gradlew(["."]));
    expect(listed.builds.map((build) => build.build)).toEqual([".", "tools/conventions"]);
    // Only Gradle's model counts: a commented-out includeBuild in the settings file is no build.
    await writeFile(join(repo, "settings.gradle.kts"), `rootProject.name = "x"\n// includeBuild("old-build")\n`);
    expect((await runGradleInventory(repo, ["."], "worktree", gradlew(["."], [], []))).builds.map((build) => build.build)).toEqual(["."]);
  });

  it("fails when a project in the manifest wrote nothing, or a build wrote no manifest or settings output", async () => {
    const missingProject: RunProcess = async (command, args, options) => {
      const result = await gradlew(["."], [], [])(command, args, options);
      const out = args.find((arg) => arg.startsWith("-DsupplyChain.out="))!.slice("-DsupplyChain.out=".length);
      const manifest = { projects: [":", ":a:b"], nestedBuilds: [] };
      await writeFile(join(out, `${encodeURIComponent(".|manifest")}.json`), JSON.stringify({ schemaVersion: 1, build: ".", project: "manifest", manifest }));
      return result;
    };
    await expect(runGradleInventory(repo, ["."], "worktree", missingProject)).rejects.toThrow("Gradle inventory of build . has no output for project(s) :a:b");
    const noManifest: RunProcess = async (command, args, options) => {
      const result = await gradlew(["."], [], [])(command, args, options);
      const out = args.find((arg) => arg.startsWith("-DsupplyChain.out="))!.slice("-DsupplyChain.out=".length);
      await rm(join(out, `${encodeURIComponent(".|manifest")}.json`));
      return result;
    };
    await expect(runGradleInventory(repo, ["."], "worktree", noManifest)).rejects.toThrow("Gradle inventory of build . wrote no manifest");
    const noSettings: RunProcess = async (command, args, options) => {
      const result = await gradlew(["."], [], [])(command, args, options);
      const out = args.find((arg) => arg.startsWith("-DsupplyChain.out="))!.slice("-DsupplyChain.out=".length);
      await rm(join(out, `${encodeURIComponent(".|settings")}.json`));
      return result;
    };
    await expect(runGradleInventory(repo, ["."], "worktree", noSettings)).rejects.toThrow("Gradle inventory of build . wrote no settings output");
  });

  it("fails on a failed Gradle run, a build without output, a missing wrapper or build directory", async () => {
    const failing: RunProcess = async () => ({ code: 1, stdout: "", stderr: "line 1\nCould not resolve all files" });
    await expect(runGradleInventory(repo, ["."], "worktree", failing)).rejects.toThrow("exit code 1: line 1 / Could not resolve all files");
    await expect(runGradleInventory(repo, ["."], "worktree", gradlew([]))).rejects.toThrow("wrote no output for it");
    await expect(runGradleInventory(repo, ["nope"], "worktree", gradlew([]))).rejects.toThrow("build nope, which doesn't exist");
    await rm(join(repo, "gradlew"));
    await expect(runGradleInventory(repo, ["."], "worktree", gradlew(["."]))).rejects.toThrow("has no ./gradlew");
  });
});

describe("Maven release age", () => {
  const maven = (name: string, version: string, locations = [":runtimeClasspath"]): Located => ({ ecosystem: "Maven", name, version, locations });
  const snapshot = (affecting: Record<string, Advisory[]>, packages: Located[]) => {
    const map = new Map<string, Advisory[]>(packages.map((pkg) => [`Maven|${pkg.name}|${pkg.version}`, []]));
    for (const [key, advisories] of Object.entries(affecting)) map.set(key, advisories);
    return new Snapshot(map, [], NOW);
  };
  const central = (name: string, version: string) => {
    const [group, artifact] = name.split(":");
    return `https://repo1.maven.org/maven2/${group!.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`;
  };
  const portal = (name: string, version: string) => central(name, version).replace("https://repo1.maven.org/maven2", "https://plugins.gradle.org/m2");

  it("checks versions head adds by their POM's Last-Modified in Central, then the Plugin Portal", async () => {
    const base = [maven("org.xerial.snappy:snappy-java", "1.1.10.8")];
    const head = [
      maven("org.xerial.snappy:snappy-java", "1.1.10.10"),
      maven("com.diffplug.spotless:spotless-plugin-gradle", "8.10.3", [":buildscript.classpath"]),
      maven("com.acme:old", "1.0"),
    ];
    const fetch = fakeFetch({
      [central("org.xerial.snappy:snappy-java", "1.1.10.10")]: { headers: { "last-modified": "Sat, 03 Oct 2026 16:51:02 GMT" } },
      [portal("com.diffplug.spotless:spotless-plugin-gradle", "8.10.3")]: { headers: { "last-modified": "Fri, 25 Sep 2026 20:13:27 GMT" } },
      [central("com.acme:old", "1.0")]: { headers: { "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" } },
    });
    const config = parseConfig({});
    const problems = await mavenChangeProblems(base, head, {
      snapshot: snapshot({}, [...base, ...head]),
      exceptions: NO_EXCEPTIONS,
      config,
      now: NOW,
      dates: new MavenDates(fetch, config.maven.repositories),
    });
    expect(problems).toEqual(["org.xerial.snappy:snappy-java@1.1.10.10 was published 2026-10-03T16:51:02.000Z (2.8 days ago, under 7)"]);
  });

  it("accepts a young fix with a releaseAge exception whose advisory the snapshot shows on the replaced version", async () => {
    const base = [maven("org.xerial.snappy:snappy-java", "1.1.10.8")];
    const head = [maven("org.xerial.snappy:snappy-java", "1.1.10.10")];
    const fetch = fakeFetch({ [central("org.xerial.snappy:snappy-java", "1.1.10.10")]: { headers: { "last-modified": "Sat, 03 Oct 2026 16:51:02 GMT" } } });
    const advisory: Advisory = { id: "GHSA-wmgv-28fv-894x", ids: ["GHSA-wmgv-28fv-894x", "CVE-2026-90559"], source: "repository", malicious: false, summary: undefined, severity: "HIGH" };
    const config = parseConfig({});
    const exceptions = parseExceptions({
      releaseAge: [
        { ecosystem: "Maven", package: "org.xerial.snappy:snappy-java", version: "1.1.10.10", advisory: "CVE-2026-90559", reason: "fix", expires: "2026-10-20" },
      ],
    });
    const problems = await mavenChangeProblems(base, head, {
      snapshot: snapshot({ "Maven|org.xerial.snappy:snappy-java|1.1.10.8": [advisory] }, [...base, ...head]),
      exceptions,
      config,
      now: NOW,
      dates: new MavenDates(fetch, config.maven.repositories),
    });
    expect(problems).toEqual([]);
  });

  it("binds a young fix's advisory to the configuration it replaces a version in, though another keeps the old one", async () => {
    // Upgraded at runtime, still the old version in tests: runtime's 1.1.10.8 is what 1.1.10.10 replaces.
    const base = [maven("org.xerial.snappy:snappy-java", "1.1.10.8", [":runtimeClasspath", ":testRuntimeClasspath"])];
    const head = [
      maven("org.xerial.snappy:snappy-java", "1.1.10.10", [":runtimeClasspath"]),
      maven("org.xerial.snappy:snappy-java", "1.1.10.8", [":testRuntimeClasspath"]),
    ];
    const fetch = fakeFetch({ [central("org.xerial.snappy:snappy-java", "1.1.10.10")]: { headers: { "last-modified": "Sat, 03 Oct 2026 16:51:02 GMT" } } });
    const advisory: Advisory = { id: "GHSA-wmgv-28fv-894x", ids: ["GHSA-wmgv-28fv-894x"], source: "repository", malicious: false, summary: undefined, severity: "HIGH" };
    const config = parseConfig({});
    const exceptions = parseExceptions({
      releaseAge: [
        { ecosystem: "Maven", package: "org.xerial.snappy:snappy-java", version: "1.1.10.10", advisory: "GHSA-wmgv-28fv-894x", reason: "fix", expires: "2026-10-20" },
      ],
    });
    const problems = await mavenChangeProblems(base, head, {
      snapshot: snapshot({ "Maven|org.xerial.snappy:snappy-java|1.1.10.8": [advisory] }, [...base, ...head]),
      exceptions,
      config,
      now: NOW,
      dates: new MavenDates(fetch, config.maven.repositories),
    });
    expect(problems).toEqual([]);
  });

  it("fails a version no configured repository has, skips own packages, and fails closed on a missing header", async () => {
    const config = parseConfig({ ownPackages: { Maven: { groups: ["io.github.leanish"], pluginIdPrefixes: ["io.github.leanish."] } } });
    const head = [
      maven("com.acme:internal", "1.0"),
      maven("io.github.leanish:java-conventions", "0.6.3"),
      maven("io.github.leanish.java-conventions:io.github.leanish.java-conventions.gradle.plugin", "0.6.3"),
    ];
    const context = (fetch: ReturnType<typeof fakeFetch>) => ({
      snapshot: snapshot({}, head),
      exceptions: NO_EXCEPTIONS,
      config,
      now: NOW,
      dates: new MavenDates(fetch, config.maven.repositories),
    });
    expect(await mavenChangeProblems([], head, context(fakeFetch({})))).toEqual([
      "com.acme:internal@1.0 isn't in https://repo1.maven.org/maven2 or https://plugins.gradle.org/m2, so the gate can't check its release age",
    ]);
    const noHeader = fakeFetch({ [central("com.acme:internal", "1.0")]: { headers: {} } });
    await expect(mavenChangeProblems([], head, context(noHeader))).rejects.toThrow("has no valid Last-Modified header");
    const down = fakeFetch({ [central("com.acme:internal", "1.0")]: { status: 503 } });
    await expect(mavenChangeProblems([], head, context(down))).rejects.toThrow("HTTP 503");
  });

  it("matches own Maven packages by exact group, and plugin-id prefixes only on marker coordinates", () => {
    const own = parseConfig({ ownPackages: { Maven: { groups: ["io.github.leanish"], pluginIdPrefixes: ["io.github.leanish."] } } }).ownPackages;
    const check = (name: string) => isOwnPackage(own, { ecosystem: "Maven", name });
    expect(check("io.github.leanish:sqs-codec")).toBe(true);
    expect(check("io.github.leanish.java-conventions:io.github.leanish.java-conventions.gradle.plugin")).toBe(true);
    expect(check("io.github.leanish.evil:anything")).toBe(false);
    expect(check("io.github.leanishx:lib")).toBe(false);
    expect(isOwnPackage(own, { ecosystem: "npm", name: "@leanish/x" })).toBe(false);
  });
});

describe("Gradle and Maven config", () => {
  it("parses builds, ignored configurations and repositories, and rejects paths outside the repository", () => {
    const config = parseConfig({ gradle: { builds: [".", "build-logic/"], ignoreConfigurations: [":odd"] }, maven: { repositories: ["https://repo.acme.dev/maven/"] } });
    expect(config.gradle.builds).toEqual([".", "build-logic"]);
    expect(config.gradle.ignoreConfigurations).toEqual([":odd"]);
    expect(config.maven.repositories).toEqual(["https://repo.acme.dev/maven"]);
    expect(parseConfig({}).gradle.builds).toBeUndefined();
    expect(() => parseConfig({ gradle: { builds: ["../other"] } })).toThrow("not a path inside the repository");
    expect(() => parseConfig({ gradle: { build: ["."] } })).toThrow("gradle has unknown field(s): build");
  });
});
