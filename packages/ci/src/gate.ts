/**
 * The two runs of the gate:
 *   - `compare` (a pull request): base and head inventories, one advisory
 *     snapshot for both, and the checks on what head adds or changes;
 *   - `scan` (the default branch, on push and daily): every finding in one
 *     tree fails unless excepted.
 * Config and exceptions come from head: they're part of what would land.
 * Gradle inventories come in as data, made by whoever ran the build.
 */
import { type Config, DEFAULT_CONFIG, parseConfig } from "./config.ts";
import { type Exceptions, NO_EXCEPTIONS, parseExceptions } from "./exceptions.ts";
import { compareFindings, findingsOf } from "./findings.ts";
import { type GradleInventory, gradleResolutionProblems } from "./gradle.ts";
import type { Fetch } from "./http.ts";
import { type Inventory, located, readInventory, type Sources, sourcesOf } from "./inventory.ts";
import { MavenDates, mavenChangeProblems } from "./maven-changes.ts";
import { npmChangeProblems } from "./npm-changes.ts";
import { sourceProblems } from "./npm-lock.ts";
import { NpmRegistry } from "./npm-registry.ts";
import { osvScannerVersion } from "./osv-scanner.ts";
import { comparisonVerdict, scanVerdict } from "./policy.ts";
import type { RunProcess } from "./process.ts";
import { takeSnapshot } from "./take-snapshot.ts";
import type { Tree } from "./tree.ts";

export const CONFIG_PATH = ".github/supply-chain.json";
export const EXCEPTIONS_PATH = ".github/supply-chain-exceptions.json";

export interface GateEnvironment {
  readonly run: RunProcess;
  readonly fetch: Fetch;
  readonly now: () => Date;
  /** The `osv-scanner` binary. */
  readonly osvScanner: string;
  readonly githubToken: string | undefined;
}

export interface GateOutcome {
  readonly failures: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly osvScannerVersion: string;
  readonly configText: string | undefined;
}

export interface Settings {
  readonly config: Config;
  readonly configText: string | undefined;
  readonly exceptions: Exceptions;
}

export async function readSettings(head: Tree): Promise<Settings> {
  const configText = await head.read(CONFIG_PATH);
  const exceptionsText = await head.read(EXCEPTIONS_PATH);
  return {
    config: configText === undefined ? DEFAULT_CONFIG : parseConfig(parseJson(configText, CONFIG_PATH)),
    configText,
    exceptions: exceptionsText === undefined ? NO_EXCEPTIONS : parseExceptions(parseJson(exceptionsText, EXCEPTIONS_PATH)),
  };
}

/** What head has to inventory under its own settings: the CLI uses it to know which Gradle builds to run. */
export async function treeSources(head: Tree): Promise<Sources> {
  return sourcesOf(head, (await readSettings(head)).config);
}

/**
 * What base has, under base's own settings. A base config that doesn't parse
 * (the PR may be fixing it) falls back to the defaults, so it can't block the
 * comparison; base lockfiles are read as listed by either side, missing ones
 * as empty.
 */
export async function baseSources(base: Tree, head: Sources): Promise<Sources> {
  const own = await lenientSources(base);
  return { lockfiles: [...new Set([...head.lockfiles, ...own.lockfiles])], gradleBuilds: own.gradleBuilds };
}

/** A tree's sources under its own settings, or the defaults when they don't parse; empty is fine. */
export async function lenientSources(tree: Tree): Promise<Sources> {
  let config: Config;
  try {
    config = (await readSettings(tree)).config;
  } catch {
    config = DEFAULT_CONFIG;
  }
  return sourcesOf(tree, config, true);
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't JSON`);
  }
}

function snapshotOptions(config: Config, env: GateEnvironment) {
  return {
    osv: { binary: env.osvScanner, run: env.run },
    sourceRepos: { fetch: env.fetch, overrides: config.repositories, mavenRepositories: config.maven.repositories },
    repositoryAdvisories: { fetch: env.fetch, token: env.githubToken },
    fetch: env.fetch,
    now: env.now,
  };
}

export interface GradleInputs {
  readonly base?: GradleInventory | undefined;
  readonly head?: GradleInventory | undefined;
}

export async function runCompare(base: Tree, head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<GateOutcome> {
  const version = await osvScannerVersion({ binary: env.osvScanner, run: env.run });
  const { config, configText, exceptions } = await readSettings(head);
  const sources = await sourcesOf(head, config);
  const headInventory = await readInventory(head, sources, { gradle: gradle.head });
  const baseInventory = await readInventory(base, await baseSources(base, sources), { missingLockfilesAreEmpty: true, gradle: gradle.base });
  const baseLocated = located(baseInventory);
  const headLocated = located(headInventory);
  const snapshot = await takeSnapshot([...baseLocated, ...headLocated], snapshotOptions(config, env));
  const now = env.now();
  const today = now.toISOString().slice(0, 10);
  const comparison = compareFindings(findingsOf(baseLocated, snapshot), findingsOf(headLocated, snapshot));
  const verdict = comparisonVerdict(comparison, exceptions, snapshot, today);
  const registry = new NpmRegistry(env.fetch);
  const changeProblems: string[] = [
    ...bundleFailures(headInventory),
    ...resolutionFailures(baseInventory, config, "base"),
    ...resolutionFailures(headInventory, config, undefined),
  ];
  for (const lockfile of headInventory.npm) {
    const before = baseInventory.npm.find((candidate) => candidate.path === lockfile.path)?.packages ?? [];
    const problems = await npmChangeProblems(before, lockfile.packages, { registry, snapshot, exceptions, config, now });
    changeProblems.push(...problems.map((problem) => prefixed(headInventory, lockfile.path, problem)));
  }
  const dates = new MavenDates(env.fetch, config.maven.repositories);
  changeProblems.push(...(await mavenChangeProblems(baseLocated, headLocated, { snapshot, exceptions, config, now, dates })));
  return {
    failures: [...verdict.failures, ...changeProblems],
    warnings: verdict.warnings,
    notes: verdict.notes,
    gaps: snapshot.gaps,
    osvScannerVersion: version,
    configText,
  };
}

export async function runScan(head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<GateOutcome> {
  const version = await osvScannerVersion({ binary: env.osvScanner, run: env.run });
  const { config, configText, exceptions } = await readSettings(head);
  const sources = await sourcesOf(head, config);
  const inventory = await readInventory(head, sources, { gradle: gradle.head });
  const packages = located(inventory);
  const snapshot = await takeSnapshot(packages, snapshotOptions(config, env));
  const verdict = scanVerdict(findingsOf(packages, snapshot), exceptions, snapshot, env.now().toISOString().slice(0, 10));
  const npmSources = inventory.npm.flatMap((lockfile) =>
    sourceProblems(lockfile.packages, config.npm.registries).map((problem) => prefixed(inventory, lockfile.path, problem)),
  );
  return {
    failures: [...verdict.failures, ...bundleFailures(inventory), ...npmSources, ...resolutionFailures(inventory, config, undefined)],
    warnings: [],
    notes: verdict.notes,
    gaps: snapshot.gaps,
    osvScannerVersion: version,
    configText,
  };
}

function bundleFailures(inventory: Inventory): string[] {
  return inventory.npm.flatMap((lockfile) => lockfile.bundleProblems.map((problem) => prefixed(inventory, lockfile.path, problem)));
}

/** A configuration that didn't resolve leaves a hole in that side's inventory, so the verdict can't stand. */
function resolutionFailures(inventory: Inventory, config: Config, side: string | undefined): string[] {
  if (inventory.gradle === undefined) return [];
  return gradleResolutionProblems(inventory.gradle, config.gradle.ignoreConfigurations).map((problem) =>
    side === undefined ? problem : `${side}: ${problem}`,
  );
}

/** Names the lockfile when there's more than one. */
function prefixed(inventory: Inventory, lockfile: string, problem: string): string {
  return inventory.npm.length > 1 ? `${lockfile}: ${problem}` : problem;
}
