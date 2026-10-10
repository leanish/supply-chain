/** Resolve Gradle without the selected security floors, inside the same sandbox as other builds. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gradleLocation, type GradleInventory, runGradleInventory } from "../../ci/src/gradle.ts";
import type { RunProcess } from "../../ci/src/process.ts";
import { runProcess } from "../../ci/src/process.ts";
import { treeSources } from "../../ci/src/gate.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { FLOORS_PATH, parseFloors, type Floor } from "../../ci/src/floors.ts";
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import type { GradleTransform } from "../../remediation/src/inventories.ts";
import { runSandboxed } from "../../remediation/src/sandboxed.ts";

const REMOVE_FLOORS_INIT = fileURLToPath(new URL("../gradle/remove-floors.init.gradle", import.meta.url));
const FLOOR_FILE_PROPERTY = "supplyChain.removeFloors.file";

interface FloorRemoval {
  readonly package: string;
  readonly version: string;
  readonly advisories: ReadonlyArray<string>;
  readonly locations: ReadonlyArray<string>;
}

interface FloorRemovalFile {
  readonly repositoryRoot: string;
  readonly floors: ReadonlyArray<FloorRemoval>;
}

/** The selected Maven floors removed by Gradle (as `unlockedGradle` does): a floor removal's reference. */
export function removalTransform(floors: ReadonlyArray<Floor>): GradleTransform {
  const removed = floors.filter((floor) => floor.ecosystem === "Maven").map(({ package: pkg, version, advisories, locations }) => ({ package: pkg, version, advisories: [...advisories], locations: [...locations] }));
  return { initScript: REMOVE_FLOORS_INIT, property: FLOOR_FILE_PROPERTY, content: (repositoryRoot): FloorRemovalFile => ({ repositoryRoot, floors: removed }) };
}

/**
 * Resolves the tree after removing the exact declared dependencies for its
 * selected Maven security floors. Compatibility floors are never candidates.
 */
export async function unlockedGradle(
  context: ToolRunContext,
  workingCopy: WorkingCopy,
  tree: Tree,
  floors: ReadonlyArray<Floor>,
  run: RunProcess = runProcess,
): Promise<GradleInventory | undefined> {
  const selected = floors.filter((floor) => floor.ecosystem === "Maven" && floor.purpose === "security");
  if (selected.length === 0) return undefined;
  for (const floor of selected) packageParts(floor.package);
  const recordedFloors = await readRecordedFloors(tree);
  rejectCompatibilityOverlap(selected, recordedFloors);

  const builds = (await treeSources(tree)).gradleBuilds;
  if (builds.length === 0) throw new Error("Maven security floors were selected, but the tree has no configured Gradle build");

  const repositoryRoot = resolve(workingCopy.path);
  const metadata: FloorRemovalFile = {
    repositoryRoot,
    floors: selected.map(({ package: pkg, version, advisories, locations }) => ({ package: pkg, version, advisories: [...advisories], locations: [...locations] })),
  };
  const tempDir = await mkdtemp(join(tmpdir(), "secure-it-gradle-floors-"));
  try {
    const floorFile = join(tempDir, "floors.json");
    const metadataJson = JSON.stringify(metadata);
    await writeFile(floorFile, metadataJson, { encoding: "utf8", mode: 0o600 });
    const sandboxedRun: RunProcess = (command, args) =>
      runSandboxed(
        context.isolation,
        { workingCopy: { ...workingCopy, path: repositoryRoot }, command: [command, ...args] },
        run,
      );
    const inventory = await runGradleInventory(repositoryRoot, builds, tree.id, sandboxedRun, {
      additionalInitScripts: [REMOVE_FLOORS_INIT],
      systemProperties: { [FLOOR_FILE_PROPERTY]: floorFile },
    });
    let metadataAfterRun: string;
    try {
      metadataAfterRun = await readFile(floorFile, "utf8");
    } catch {
      throw new Error("Gradle floor-removal metadata disappeared while the sandboxed build ran");
    }
    if (metadataAfterRun !== metadataJson) {
      throw new Error("Gradle floor-removal metadata changed while the sandboxed build ran");
    }
    verifyRemoval(inventory, selected);
    return inventory;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readRecordedFloors(tree: Tree): Promise<ReadonlyArray<Floor>> {
  const source = await tree.read(FLOORS_PATH);
  if (source === undefined) throw new Error(`can't remove Gradle floors: ${FLOORS_PATH} is missing from ${tree.id}`);
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (cause) {
    throw new Error(`can't remove Gradle floors: ${FLOORS_PATH} is not valid JSON`, { cause });
  }
  return parseFloors(raw);
}

function packageParts(pkg: string): readonly [group: string, name: string] {
  const parts = pkg.split(":");
  if (parts.length !== 2 || parts.some((part) => part.trim() === "")) {
    throw new Error(`Gradle security floor package must be group:name; got ${pkg}`);
  }
  return [parts[0]!, parts[1]!];
}

function rejectCompatibilityOverlap(selected: ReadonlyArray<Floor>, floors: ReadonlyArray<Floor>): void {
  for (const floor of selected) {
    const compatibility = floors.find((candidate) =>
      candidate.ecosystem === "Maven" &&
      candidate.purpose === "compatibility" &&
      candidate.package === floor.package &&
      candidate.version === floor.version &&
      floor.locations.some((location) => candidate.locations.includes(location)),
    );
    if (compatibility !== undefined) {
      throw new Error(
        `can't remove security floor ${floor.package}:${floor.version} in ${floor.locations.join(", ")}: the same declaration is also a compatibility floor`,
      );
    }
  }
}

function verifyRemoval(inventory: GradleInventory, floors: ReadonlyArray<Floor>): void {
  for (const floor of floors) {
    const [group, name] = packageParts(floor.package);
    for (const location of floor.locations) {
      const configuration = inventory.builds
        .flatMap((build) => build.configurations.map((config) => ({ location: gradleLocation(build.build, config.id), config })))
        .find((candidate) => candidate.location === location)?.config;
      if (configuration === undefined) {
        throw new Error(`can't remove security floor ${floor.package}:${floor.version}: Gradle has no resolvable configuration ${location}`);
      }
      if (configuration.error !== undefined || configuration.unresolved.length > 0) {
        const detail = configuration.error ?? configuration.unresolved.map(({ requested, failure }) => `${requested}: ${failure}`).join("; ");
        throw new Error(`can't verify removal of security floor ${floor.package}:${floor.version} in ${location}: ${detail}`);
      }
      const remains = configuration.declared.some((dependency) =>
        dependency.group === group &&
        dependency.name === name &&
        dependency.version === floor.version &&
        floor.advisories.every((advisory) => dependency.reason?.toUpperCase().includes(advisory.toUpperCase()) === true),
      );
      if (remains) {
        throw new Error(`Gradle still declares security floor ${floor.package}:${floor.version} in ${location} after the unlocked probe`);
      }
    }
  }
}
