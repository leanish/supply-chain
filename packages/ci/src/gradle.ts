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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Located } from "./findings.ts";
import { isObject } from "./json.ts";
import { versionKey } from "./package-version.ts";
import { type RunProcess, withoutCredentials } from "./process.ts";

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

export interface GradleInventoryOptions {
  /** Applied before the inventory script so their Gradle lifecycle hooks run first. */
  readonly additionalInitScripts?: ReadonlyArray<string>;
  /** Extra Gradle system properties, passed as individual arguments (never through a shell). */
  readonly systemProperties?: Readonly<Record<string, string>>;
}

/**
 * Runs the init script in every listed build and collects what it wrote,
 * nested builds included (buildSrc, included builds, plugin builds Gradle
 * configured in the run). Each build's manifest, from Gradle's own model,
 * must be matched: every project exported, and every nested build exported
 * (one the run didn't configure has to be listed in `gradle.builds` itself).
 */
export async function runGradleInventory(
  repoDir: string,
  builds: ReadonlyArray<string>,
  tree: string,
  run: RunProcess,
  options: GradleInventoryOptions = {},
): Promise<GradleInventory> {
  // Absolute: the wrapper runs with the repository as its working directory, so a relative path would resolve twice.
  const repoRoot = resolve(repoDir);
  if (!(await exists(join(repoRoot, "gradlew")))) throw new Error("supply-chain.json lists Gradle builds, but the repository has no ./gradlew");
  const collected = new Map<string, GradleConfiguration[]>();
  const nested = new Set<string>();
  for (const build of builds) {
    if (!(await exists(join(repoRoot, build)))) throw new Error(`supply-chain.json lists Gradle build ${build}, which doesn't exist`);
    if (collected.has(normalize(build))) continue;
    const out = await mkdtemp(join(tmpdir(), "supply-chain-gradle-"));
    try {
      // A reused daemon keeps the sandbox it started in. Any daemon needed here must be single-use, CI included.
      const extraInitScripts = (options.additionalInitScripts ?? []).flatMap((script) => ["--init-script", script]);
      const systemProperties = Object.entries(options.systemProperties ?? {}).map(([key, value]) => `-D${key}=${value}`);
      const args = [
        "-p",
        build,
        ...extraInitScripts,
        "--init-script",
        INIT_SCRIPT,
        `-DsupplyChain.out=${out}`,
        ...systemProperties,
        "--no-daemon",
        "--no-configuration-cache",
        "--quiet",
        "supplyChainInventory",
      ];
      // The build is the repository's own code: it gets no credentials.
      const result = await run(join(repoRoot, "gradlew"), args, { cwd: repoRoot, env: withoutCredentials(process.env) });
      if (result.code !== 0) {
        throw new Error(`Gradle inventory of build ${build} failed with exit code ${result.code}: ${gradleFailureDetails(result.stderr)}`);
      }
      const written = await readRun(out, build);
      if (!written.has(normalize(build))) throw new Error(`Gradle inventory of build ${build} wrote no output for it`);
      for (const [label, output] of written) {
        for (const child of output.nestedBuilds) nested.add(child);
        if (!collected.has(label)) collected.set(label, output.configurations);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }
  const missing = [...nested].filter((build) => !collected.has(build)).sort();
  if (missing.length > 0) {
    throw new Error(`Gradle builds that weren't inventoried (list them in supply-chain.json gradle.builds): ${missing.join(", ")}`);
  }
  return {
    schemaVersion: GRADLE_INVENTORY_SCHEMA_VERSION,
    tree,
    builds: [...collected].map(([build, configurations]) => ({ build, configurations })),
  };
}

/** Keep Gradle's problem description through both the wrapper and the sandboxed CLI's error report. */
export function gradleFailureDetails(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/);
  const problem = lines.findIndex((line) => line.includes("* What went wrong:"));
  if (problem !== -1) {
    const following = lines.slice(problem + 1);
    const nextSection = following.findIndex((line) => /^\s*(?:\* (?:Try:|Exception is:|Get more help)|BUILD FAILED|[Uu]sage:)/.test(line));
    const block = lines.slice(problem, nextSection === -1 ? undefined : problem + 1 + nextSection);
    return block.map((line) => line.trim()).filter((line) => line !== "").join(" / ");
  }
  const caused = lines.find((line) => line.includes("Caused by:"));
  if (caused !== undefined) {
    return caused.trim();
  }
  const reported = lines.find((line) => line.includes("Gradle inventory of build ") && line.includes("failed"));
  if (reported !== undefined) {
    return reported.trim();
  }
  return lines.slice(-5).join(" / ");
}

interface BuildOutput {
  readonly configurations: GradleConfiguration[];
  readonly nestedBuilds: ReadonlyArray<string>;
}

/** The files one Gradle run wrote, grouped by build (relative to the repository), each checked against its manifest. */
async function readRun(out: string, requested: string): Promise<Map<string, BuildOutput>> {
  const configurations = new Map<string, GradleConfiguration[]>();
  const projects = new Map<string, Set<string>>();
  const settings = new Set<string>();
  const manifests = new Map<string, { projects: string[]; nestedBuilds: string[] }>();
  for (const file of (await readdir(out)).filter((name) => name.endsWith(".json")).sort()) {
    const content: unknown = JSON.parse(await readFile(join(out, file), "utf8"));
    if (!isObject(content) || typeof content["build"] !== "string" || typeof content["project"] !== "string") {
      throw new Error(`Gradle inventory of build ${requested}: ${file} is malformed`);
    }
    const label = normalize(join(requested, content["build"]));
    if (content["project"] === "manifest") {
      const manifest = content["manifest"];
      const listed = isObject(manifest) ? manifest["projects"] : undefined;
      const children = isObject(manifest) ? manifest["nestedBuilds"] : undefined;
      if (!isStrings(listed) || !isStrings(children)) throw new Error(`Gradle inventory of build ${requested}: ${file} has a malformed manifest`);
      manifests.set(label, { projects: listed, nestedBuilds: children.map((child) => normalize(join(requested, child))) });
      continue;
    }
    if (!Array.isArray(content["configurations"])) throw new Error(`Gradle inventory of build ${requested}: ${file} has no configurations`);
    configurations.set(label, [...(configurations.get(label) ?? []), ...content["configurations"].map((config) => parseConfiguration(config, `${requested}/${file}`))]);
    if (content["project"] === "settings") settings.add(label);
    else projects.set(label, (projects.get(label) ?? new Set()).add(content["project"]));
  }
  const builds = new Map<string, BuildOutput>();
  for (const [label, configs] of configurations) {
    const manifest = manifests.get(label);
    if (manifest === undefined) throw new Error(`Gradle inventory of build ${label} wrote no manifest`);
    // The settings classpath (settings plugins) comes in its own file, even when empty.
    if (!settings.has(label)) throw new Error(`Gradle inventory of build ${label} wrote no settings output`);
    const missing = manifest.projects.filter((project) => !projects.get(label)?.has(project));
    if (missing.length > 0) throw new Error(`Gradle inventory of build ${label} has no output for project(s) ${missing.join(", ")}`);
    rejectDuplicateConfigurations(label, configs);
    builds.set(label, { configurations: configs, nestedBuilds: manifest.nestedBuilds });
  }
  return builds;
}

/** Two configurations of a build with one id (a project configuration named `buildscript.classpath`, say) would hide one another. */
function rejectDuplicateConfigurations(build: string, configurations: ReadonlyArray<GradleConfiguration>): void {
  const ids = configurations.map((configuration) => configuration.id);
  const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (twice.length > 0) throw new Error(`Gradle inventory of build ${build} has more than one configuration at ${[...new Set(twice)].sort().join(", ")}`);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
 * Reads an inventory written by `gradle-inventory`, checking its shape, its
 * commit, and that it covers every build the tree's sources list (it may
 * cover more: the nested builds the run exported).
 */
export function parseGradleInventory(raw: unknown, tree: string, builds: ReadonlyArray<string>): GradleInventory {
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
    const configurations = entry["configurations"].map((config) => parseConfiguration(config, build));
    rejectDuplicateConfigurations(build, configurations);
    return { build, configurations };
  });
  const names = parsed.map((build) => build.build);
  const missing = builds.filter((build) => !names.includes(build));
  if (missing.length > 0) {
    throw new Error(`Gradle inventory covers builds ${names.join(", ") || "none"}, missing ${missing.join(", ")} from supply-chain.json`);
  }
  if (new Set(names).size !== names.length) throw new Error("Gradle inventory lists a build twice");
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
