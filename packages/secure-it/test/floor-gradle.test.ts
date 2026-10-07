import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { FLOORS_PATH, type Floor } from "../../ci/src/floors.ts";
import type { RunProcess } from "../../ci/src/process.ts";
import type { Tree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { unlockedGradle } from "../src/floor-gradle.ts";

const INVENTORY_INIT = fileURLToPath(new URL("../../ci/gradle/supply-chain-inventory.init.gradle", import.meta.url));
const REMOVE_INIT = fileURLToPath(new URL("../gradle/remove-floors.init.gradle", import.meta.url));
const FLOOR_PROPERTY = "supplyChain.removeFloors.file";

const securityFloor = (pkg: string, location: string, overrides: Partial<Floor> = {}): Floor => ({
  ecosystem: "Maven",
  package: pkg,
  version: "1.2.3",
  declaredIn: "build.gradle.kts",
  locations: [location],
  overridePaths: [],
  purpose: "security",
  advisories: ["CVE-2026-12345"],
  reason: "security issue",
  added: "2026-10-01",
  ...overrides,
});

const compatibilityFloor: Floor = {
  ecosystem: "Maven",
  package: "org.compat:api",
  version: "2.0.0",
  declaredIn: "build.gradle.kts",
  locations: [":runtimeClasspath"],
  overridePaths: [],
  purpose: "compatibility",
  advisories: [],
  reason: "plugin needs this API",
  added: "2026-10-01",
};

function tree(floors: ReadonlyArray<Floor> = []): Tree {
  const files: Record<string, string> = {
    ".github/supply-chain.json": JSON.stringify({ gradle: { builds: ["."] } }),
    [FLOORS_PATH]: JSON.stringify({ floors: floors.map((floor) => ({
      ecosystem: floor.ecosystem,
      package: floor.package,
      version: floor.version,
      declaredIn: floor.declaredIn,
      selector: floor.ecosystem === "Maven" ? floor.locations : floor.overridePaths,
      purpose: floor.purpose,
      advisories: floor.advisories,
      reason: floor.reason,
      added: floor.added,
    })) }),
  };
  return { id: "tree-id", read: async (path) => files[path], list: async () => [] };
}

function rawConfiguration(
  id: string,
  kind: "project" | "buildscript" | "settings",
  declared: ReadonlyArray<{ group: string; name: string; version: string; reason?: string }> = [],
) {
  return {
    id,
    kind,
    resolved: [],
    unresolved: [],
    declared: declared.map((dependency) => ({ reason: null, ...dependency })),
    error: null,
  };
}

async function writeInventory(out: string, build: string, configs: ReadonlyArray<object>, nestedBuilds: ReadonlyArray<string> = []): Promise<void> {
  const file = (project: string) => join(out, `${encodeURIComponent(`${build}|${project}`)}.json`);
  await writeFile(file(":"), JSON.stringify({ schemaVersion: 1, build, project: ":", configurations: configs }));
  await writeFile(file("settings"), JSON.stringify({ schemaVersion: 1, build, project: "settings", configurations: [] }));
  await writeFile(file("manifest"), JSON.stringify({ schemaVersion: 1, build, project: "manifest", manifest: { projects: [":"], nestedBuilds } }));
}

describe("unlockedGradle", () => {
  let root: string;
  let workingCopy: WorkingCopy;
  const context = { isolation: { readDenied: [], env: {} } } as unknown as ToolRunContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "secure-it-floor-gradle-"));
    await mkdir(join(root, "git"));
    await writeFile(join(root, "gradlew"), "");
    await writeFile(join(root, "settings.gradle.kts"), "rootProject.name = \"fixture\"\n");
    await writeFile(join(root, "build.gradle.kts"), "");
    workingCopy = { projectId: "fixture/repo", path: root, branch: "main", headSha: "tree-id", gitDir: join(root, "git") };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs the inventory sandboxed with checked JSON metadata and removes only selected Maven security declarations", async () => {
    const floors = [
      securityFloor("org.project:lib", ":runtimeClasspath"),
      securityFloor("org.build:plugin", ":buildscript.classpath"),
      securityFloor("org.settings:plugin", "settings.classpath"),
      securityFloor("org.nested:lib", "build-logic/:runtimeClasspath"),
      compatibilityFloor,
    ];
    const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd: string | undefined; env: NodeJS.ProcessEnv | undefined }> = [];
    let metadataPath: string | undefined;
    process.env["FLOOR_PROBE_TEST_TOKEN"] = "must-not-reach-gradle";
    try {
      const run: RunProcess = async (command, args, options) => {
        calls.push({ command, args: [...args], cwd: options?.cwd, env: options?.env });
        const outputArg = args.find((arg) => arg.startsWith("-DsupplyChain.out="));
        const floorArg = args.find((arg) => arg.startsWith(`-D${FLOOR_PROPERTY}=`));
        expect(outputArg).toBeDefined();
        expect(floorArg).toBeDefined();
        const out = outputArg!.slice("-DsupplyChain.out=".length);
        metadataPath = floorArg!.slice(`-D${FLOOR_PROPERTY}=`.length);
        const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { repositoryRoot: string; floors: Array<{ package: string }> };
        expect(metadata.repositoryRoot).toBe(root);
        expect(metadata.floors.map((floor) => floor.package)).toEqual([
          "org.project:lib",
          "org.build:plugin",
          "org.settings:plugin",
          "org.nested:lib",
        ]);

        await writeInventory(out, ".", [
          rawConfiguration(":runtimeClasspath", "project", [{ group: "org.other", name: "unrelated", version: "4.5.6", reason: "other security finding" }]),
          rawConfiguration(":buildscript.classpath", "buildscript"),
        ], ["build-logic"]);
        await writeInventory(out, "build-logic", [rawConfiguration(":runtimeClasspath", "project")]);
        // The settings configuration is emitted separately by the inventory init script.
        await writeFile(
          join(out, `${encodeURIComponent(".|settings")}.json`),
          JSON.stringify({ schemaVersion: 1, build: ".", project: "settings", configurations: [rawConfiguration("settings.classpath", "settings")] }),
        );
        return { code: 0, stdout: "", stderr: "" };
      };

      const inventory = await unlockedGradle(context, workingCopy, tree(floors), floors, run);
      expect(inventory?.builds.map((build) => build.build)).toEqual([".", "build-logic"]);
      expect(inventory?.builds[0]?.configurations.find((config) => config.id === ":runtimeClasspath")?.declared).toEqual([
        { group: "org.other", name: "unrelated", version: "4.5.6", reason: "other security finding" },
      ]);

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.command).toBe("codex");
      expect(call.args[0]).toBe("sandbox");
      expect(call.args).toContain("--no-daemon");
      expect(call.args).toContain("--no-configuration-cache");
      expect(call.args).toContain(REMOVE_INIT);
      expect(call.args.indexOf(REMOVE_INIT)).toBeLessThan(call.args.indexOf(INVENTORY_INIT));
      expect(call.args.join(" ")).not.toContain("org.project:lib");
      expect(call.env?.["FLOOR_PROBE_TEST_TOKEN"]).toBeUndefined();
      expect(call.cwd).toBe(root);
      await expect(readFile(metadataPath!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      delete process.env["FLOOR_PROBE_TEST_TOKEN"];
    }
  });

  it("fails if a selected floor remains in the returned inventory", async () => {
    const floor = securityFloor("org.project:lib", ":runtimeClasspath");
    const run: RunProcess = async (_command, args) => {
      const out = args.find((arg) => arg.startsWith("-DsupplyChain.out="))!.slice("-DsupplyChain.out=".length);
      await writeInventory(out, ".", [rawConfiguration(":runtimeClasspath", "project", [
        { group: "org.project", name: "lib", version: "1.2.3", reason: "CVE-2026-12345" },
      ])], []);
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(unlockedGradle(context, workingCopy, tree([floor]), [floor], run)).rejects.toThrow(
      "still declares security floor org.project:lib:1.2.3 in :runtimeClasspath",
    );
  });

  it("returns no Gradle inventory for compatibility-only floors and rejects an overlapping compatibility floor", async () => {
    const run: RunProcess = async () => { throw new Error("Gradle must not run"); };
    await expect(unlockedGradle(context, workingCopy, tree(), [compatibilityFloor], run)).resolves.toBeUndefined();
    const overlappingSecurity = securityFloor("org.compat:api", ":runtimeClasspath", {
      version: compatibilityFloor.version,
      declaredIn: "included/build.gradle.kts",
    });
    await expect(unlockedGradle(context, workingCopy, tree([overlappingSecurity, compatibilityFloor]), [overlappingSecurity], run))
      .rejects.toThrow("same declaration is also a compatibility floor");
  });

  it("fails if Gradle changes the temporary floor metadata", async () => {
    const floor = securityFloor("org.project:lib", ":runtimeClasspath");
    const run: RunProcess = async (_command, args) => {
      const out = args.find((arg) => arg.startsWith("-DsupplyChain.out="))!.slice("-DsupplyChain.out=".length);
      const metadataPath = args.find((arg) => arg.startsWith(`-D${FLOOR_PROPERTY}=`))!.slice(`-D${FLOOR_PROPERTY}=`.length);
      await writeInventory(out, ".", [rawConfiguration(":runtimeClasspath", "project")]);
      await writeFile(metadataPath, "{}");
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(unlockedGradle(context, workingCopy, tree([floor]), [floor], run)).rejects.toThrow(
      "Gradle floor-removal metadata changed while the sandboxed build ran",
    );
  });

  it("uses lifecycle hooks for all Gradle scopes and copies the selected hierarchy without mutating shared parents", async () => {
    const script = await readFile(REMOVE_INIT, "utf8");
    expect(script).toContain("gradle.beforeSettings");
    expect(script).toContain("settingsEvaluated");
    expect(script).toContain("project.configurations.configureEach");
    expect(script).toContain("project.buildscript.configurations.configureEach");
    expect(script).toContain("gradle.projectsEvaluated");
    expect(script).toContain("configuration.copyRecursive");
    expect(script).toContain("configuration.incoming.beforeResolve");
    expect(script).toContain('if (configuration.state.toString() == "UNRESOLVED")');
    expect(script).toContain("if (!configuredConfigurations.add(configuration)) return");
    expect(script).toContain("configuration.setExtendsFrom([unforced])");
    expect(script).toContain("configuration.dependencyConstraints.clear()");
    expect(script).toContain("configuration.resolutionStrategy.deactivateDependencyLocking()");
    expect(script).toContain("floor.advisories.every");
    expect(script).not.toContain("removeFloors(configuration, configLocation, dependencies)");
  });
});
