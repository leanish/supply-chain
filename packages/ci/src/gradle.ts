/**
 * Gradle inventories: what each configured build really resolves, exported
 * by `gradle/supply-chain-inventory.init.gradle` and read back as data.
 *
 * Running Gradle runs the build's own code, so in CI the inventory is made in
 * a job of its own and the comparator only reads the JSON it wrote (and
 * checks it names the commit being compared). Locally, `scan --head worktree`
 * runs it inline.
 *
 * A configuration that didn't resolve fails the run: an inventory with holes
 * would read as clean.
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Located } from "./findings.ts";
import { isObject } from "./json.ts";
import { versionKey } from "./package-version.ts";
import type { RunProcess } from "./process.ts";

export const GRADLE_INVENTORY_SCHEMA_VERSION = 1;
const INIT_SCRIPT = fileURLToPath(new URL("../gradle/supply-chain-inventory.init.gradle", import.meta.url));

export interface Coordinates {
  readonly group: string;
  readonly name: string;
  readonly version: string;
}

export interface DeclaredDependency {
  readonly group: string;
  readonly name: string;
  readonly version: string | undefined;
  /** Gradle's `because(...)`. */
  readonly reason: string | undefined;
}

export interface GradleConfiguration {
  /** Project-qualified: `:runtimeClasspath`, `:sub:testRuntimeClasspath`, `:buildscript.classpath`, `settings.classpath`. */
  readonly id: string;
  readonly kind: "project" | "buildscript" | "settings";
  readonly resolved: ReadonlyArray<Coordinates>;
  readonly unresolved: ReadonlyArray<{ readonly requested: string; readonly failure: string }>;
  readonly declared: ReadonlyArray<DeclaredDependency>;
  readonly error: string | undefined;
}

export interface GradleBuild {
  /** The build's directory, relative to the repository root (`.` for the root build). */
  readonly build: string;
  readonly configurations: ReadonlyArray<GradleConfiguration>;
}

export interface GradleInventory {
  readonly schemaVersion: number;
  /** The commit (or `worktree`) the inventory was made from. */
  readonly tree: string;
  readonly builds: ReadonlyArray<GradleBuild>;
}

/**
 * Runs the init script in every listed build and collects what it wrote,
 * nested builds included (buildSrc, and included builds Gradle configured).
 * Every buildSrc and `includeBuild(...)` must end up inventoried: one Gradle
 * didn't configure in a listed build's run has to be listed itself.
 */
export async function runGradleInventory(
  repoRoot: string,
  builds: ReadonlyArray<string>,
  tree: string,
  run: RunProcess,
): Promise<GradleInventory> {
  if (!(await exists(join(repoRoot, "gradlew")))) throw new Error("supply-chain.json lists Gradle builds, but the repository has no ./gradlew");
  const collected = new Map<string, GradleConfiguration[]>();
  for (const build of builds) {
    if (!(await exists(join(repoRoot, build)))) throw new Error(`supply-chain.json lists Gradle build ${build}, which doesn't exist`);
    if (collected.has(normalize(build))) continue;
    const out = await mkdtemp(join(tmpdir(), "supply-chain-gradle-"));
    try {
      const args = ["-p", build, "--init-script", INIT_SCRIPT, `-DsupplyChain.out=${out}`, "--no-configuration-cache", "--quiet", "supplyChainInventory"];
      const result = await run(join(repoRoot, "gradlew"), args, { cwd: repoRoot });
      if (result.code !== 0) {
        const tail = result.stderr.trim().split("\n").slice(-5).join(" / ");
        throw new Error(`Gradle inventory of build ${build} failed with exit code ${result.code}: ${tail}`);
      }
      const written = new Map<string, GradleConfiguration[]>();
      for (const file of (await readdir(out)).filter((name) => name.endsWith(".json")).sort()) {
        const content: unknown = JSON.parse(await readFile(join(out, file), "utf8"));
        if (!isObject(content) || typeof content["build"] !== "string" || !Array.isArray(content["configurations"])) {
          throw new Error(`Gradle inventory of build ${build}: ${file} is malformed`);
        }
        const label = normalize(join(build, content["build"]));
        written.set(label, [...(written.get(label) ?? []), ...content["configurations"].map((config) => parseConfiguration(config, `${build}/${file}`))]);
      }
      if (!written.has(normalize(build))) throw new Error(`Gradle inventory of build ${build} wrote no output for it`);
      for (const [label, configurations] of written) if (!collected.has(label)) collected.set(label, configurations);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }
  const missing = (await nestedBuilds(repoRoot, [...collected.keys()])).filter((build) => !collected.has(build));
  if (missing.length > 0) {
    throw new Error(`Gradle builds that weren't inventoried (list them in supply-chain.json gradle.builds): ${missing.join(", ")}`);
  }
  return {
    schemaVersion: GRADLE_INVENTORY_SCHEMA_VERSION,
    tree,
    builds: [...collected].map(([build, configurations]) => ({ build, configurations })),
  };
}

/** buildSrc directories and `includeBuild(...)` targets of these builds, recursively. */
async function nestedBuilds(repoRoot: string, builds: ReadonlyArray<string>): Promise<string[]> {
  const found = new Set<string>();
  const queue = [...builds];
  while (queue.length > 0) {
    const build = queue.shift()!;
    const dir = join(repoRoot, build);
    const candidates: string[] = [];
    if (await exists(join(dir, "buildSrc"))) candidates.push(normalize(join(build, "buildSrc")));
    for (const settings of ["settings.gradle.kts", "settings.gradle"]) {
      const text = await readFile(join(dir, settings), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      for (const match of text.matchAll(/includeBuild\s*\(?\s*["']([^"']+)["']/g)) candidates.push(normalize(join(build, match[1]!)));
    }
    for (const candidate of candidates) {
      if (found.has(candidate)) continue;
      found.add(candidate);
      queue.push(candidate);
    }
  }
  return [...found].sort();
}

function normalize(path: string): string {
  const cleaned = join(path).replace(/\/+$/, "");
  return cleaned === "" ? "." : cleaned;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Reads an inventory written by `gradle-inventory`, checking its shape and
 * its commit, and, when `builds` is given, that it covers exactly those
 * (head's; base may have had other builds).
 */
export function parseGradleInventory(raw: unknown, tree: string, builds: ReadonlyArray<string> | undefined): GradleInventory {
  if (!isObject(raw) || raw["schemaVersion"] !== GRADLE_INVENTORY_SCHEMA_VERSION) {
    throw new Error(`Gradle inventory: schemaVersion must be ${GRADLE_INVENTORY_SCHEMA_VERSION}`);
  }
  if (raw["tree"] !== tree) throw new Error(`Gradle inventory was made from ${String(raw["tree"])}, not ${tree}`);
  const listed = raw["builds"];
  if (!Array.isArray(listed)) throw new Error("Gradle inventory has no builds");
  const parsed = listed.map((entry: unknown): GradleBuild => {
    if (!isObject(entry) || typeof entry["build"] !== "string" || !Array.isArray(entry["configurations"])) {
      throw new Error("Gradle inventory has a malformed build");
    }
    const build = entry["build"];
    return { build, configurations: entry["configurations"].map((config) => parseConfiguration(config, build)) };
  });
  const names = parsed.map((build) => build.build);
  if (builds !== undefined && (names.length !== builds.length || builds.some((build) => !names.includes(build)))) {
    throw new Error(`Gradle inventory covers builds ${names.join(", ") || "none"}, but supply-chain.json lists ${builds.join(", ")}`);
  }
  return { schemaVersion: GRADLE_INVENTORY_SCHEMA_VERSION, tree, builds: parsed };
}

function parseConfiguration(raw: unknown, where: string): GradleConfiguration {
  if (!isObject(raw) || typeof raw["id"] !== "string" || !["project", "buildscript", "settings"].includes(raw["kind"] as string)) {
    throw new Error(`Gradle inventory (${where}): malformed configuration`);
  }
  const id = raw["id"];
  const list = (field: string): unknown[] => {
    const value = raw[field];
    if (!Array.isArray(value)) throw new Error(`Gradle inventory (${where}): ${id}.${field} must be a list`);
    return value;
  };
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value === "") throw new Error(`Gradle inventory (${where}): ${id} has a malformed ${field}`);
    return value;
  };
  const optional = (value: unknown, field: string): string | undefined => (value === null || value === undefined ? undefined : text(value, field));
  return {
    id,
    kind: raw["kind"] as GradleConfiguration["kind"],
    resolved: list("resolved").map((entry) => {
      const item = isObject(entry) ? entry : {};
      return { group: text(item["group"], "group"), name: text(item["name"], "name"), version: text(item["version"], "version") };
    }),
    unresolved: list("unresolved").map((entry) => {
      const item = isObject(entry) ? entry : {};
      return { requested: text(item["requested"], "requested"), failure: optional(item["failure"], "failure") ?? "unknown failure" };
    }),
    declared: list("declared").map((entry) => {
      const item = isObject(entry) ? entry : {};
      return {
        group: text(item["group"], "group"),
        name: text(item["name"], "name"),
        version: optional(item["version"], "version"),
        reason: optional(item["reason"], "reason"),
      };
    }),
    error: optional(raw["error"], "error"),
  };
}

/** `:runtimeClasspath` for the root build, `buildSrc/:runtimeClasspath` for another. */
export function gradleLocation(build: string, configuration: string): string {
  return build === "." ? configuration : `${build}/${configuration}`;
}

/** Every resolved module version, with the configurations that resolve it. */
export function gradleLocated(inventory: GradleInventory): Located[] {
  const byVersion = new Map<string, { name: string; version: string; locations: string[] }>();
  for (const build of inventory.builds) {
    for (const configuration of build.configurations) {
      for (const component of configuration.resolved) {
        const name = `${component.group}:${component.name}`;
        const key = versionKey({ ecosystem: "Maven", name, version: component.version });
        const entry = byVersion.get(key) ?? { name, version: component.version, locations: [] };
        entry.locations.push(gradleLocation(build.build, configuration.id));
        byVersion.set(key, entry);
      }
    }
  }
  return [...byVersion.values()].map((entry) => ({ ecosystem: "Maven", ...entry }));
}

/** Configurations that didn't fully resolve, unless config ignores them. */
export function gradleResolutionProblems(inventory: GradleInventory, ignored: ReadonlyArray<string>): string[] {
  const problems: string[] = [];
  for (const build of inventory.builds) {
    for (const configuration of build.configurations) {
      const location = gradleLocation(build.build, configuration.id);
      if (ignored.includes(location)) continue;
      if (configuration.error !== undefined) problems.push(`Gradle ${location} didn't resolve: ${configuration.error}`);
      for (const missing of configuration.unresolved) problems.push(`Gradle ${location} couldn't resolve ${missing.requested}: ${missing.failure}`);
    }
  }
  return problems;
}
