/**
 * The two runs of the gate:
 *   - `compare` (a pull request): base and head inventories, one advisory
 *     snapshot for both, and the checks on what head adds or changes;
 *   - `scan` (the default branch, on push and daily): every finding in one
 *     tree fails unless excepted.
 * Config and exceptions come from head: they're part of what would land.
 * Gradle inventories come in as data, made by whoever ran the build; actions
 * are read from the workflows and resolved with GitHub.
 */
import { type Config, DEFAULT_CONFIG, parseConfig } from "./config.ts";
import { type Exceptions, NO_EXCEPTIONS, parseExceptions } from "./exceptions.ts";
import { compareFindings, findingsOf, type Located } from "./findings.ts";
import { checkFloors, type Floor, FLOORS_PATH, parseFloors } from "./floors.ts";
import { type GradleInventory, gradleResolutionProblems } from "./gradle.ts";
import type { Fetch } from "./http.ts";
import { type Inventory, isEmpty, located, readInventory, type Sources, sourcesOf } from "./inventory.ts";
import { ActionsCatalog, actionChanges, actionGaps, actionsLocated, resolveUses } from "./actions-changes.ts";
import type { Resolution } from "./actions-inventory.ts";
import { ActionsGitHub } from "./actions-github.ts";
import { MavenCatalog, NpmCatalog } from "./catalogs.ts";
import { MavenDates, mavenChanges } from "./maven-changes.ts";
import { npmChanges } from "./npm-changes.ts";
import { sourceProblems } from "./npm-lock.ts";
import { NpmRegistry } from "./npm-registry.ts";
import { osvScannerVersion } from "./osv-scanner.ts";
import { versionKey } from "./package-version.ts";
import { comparisonVerdict, scanVerdict } from "./policy.ts";
import type { RunProcess } from "./process.ts";
import { type ChangedVersion, isYoung, releaseAgeProblems } from "./release-age.ts";
import type { Snapshot } from "./snapshot.ts";
import { type SnapshotOptions, takeSnapshot } from "./take-snapshot.ts";
import type { Tree } from "./tree.ts";
import type { Ecosystem } from "./versions.ts";
import { gatherCandidates, type VersionCatalog } from "./young-fixes.ts";

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
  readonly floors: ReadonlyArray<Floor>;
}

export async function readSettings(head: Tree): Promise<Settings> {
  const configText = await head.read(CONFIG_PATH);
  const exceptionsText = await head.read(EXCEPTIONS_PATH);
  const floorsText = await head.read(FLOORS_PATH);
  return {
    config: configText === undefined ? DEFAULT_CONFIG : parseConfig(parseJson(configText, CONFIG_PATH)),
    configText,
    exceptions: exceptionsText === undefined ? NO_EXCEPTIONS : parseExceptions(parseJson(exceptionsText, EXCEPTIONS_PATH)),
    floors: floorsText === undefined ? [] : parseFloors(parseJson(floorsText, FLOORS_PATH)),
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
  return sourcesOf(tree, config);
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't JSON`);
  }
}

/** Every version each ecosystem's registry lists, and when each was published. */
export function versionCatalogs(
  config: Config,
  env: GateEnvironment,
  github: ActionsGitHub,
  registry: NpmRegistry = new NpmRegistry(env.fetch),
): Readonly<Record<Ecosystem, VersionCatalog>> {
  const dates = new MavenDates(env.fetch, config.maven.repositories);
  return {
    npm: new NpmCatalog(registry),
    Maven: new MavenCatalog(env.fetch, config.maven.repositories, dates),
    "GitHub Actions": new ActionsCatalog(github),
  };
}

export function snapshotOptions(config: Config, env: GateEnvironment, actions: ActionsGitHub): SnapshotOptions {
  return {
    osv: { binary: env.osvScanner, run: env.run },
    sourceRepos: { fetch: env.fetch, overrides: config.repositories, mavenRepositories: config.maven.repositories },
    repositoryAdvisories: { fetch: env.fetch, token: env.githubToken },
    fetch: env.fetch,
    actions,
    now: env.now,
  };
}

export interface GradleInputs {
  readonly base?: GradleInventory | undefined;
  readonly head?: GradleInventory | undefined;
}

export async function runCompare(base: Tree, head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<GateOutcome> {
  const version = await osvScannerVersion({ binary: env.osvScanner, run: env.run });
  const { config, configText, exceptions, floors } = await readSettings(head);
  const sources = await sourcesOf(head, config);
  const headInventory = await readInventory(head, sources, { gradle: gradle.head });
  if (isEmpty(headInventory)) throw new Error(`${head.id} has no lockfile, Gradle build or workflow for the gate to check`);
  const baseInventory = await readInventory(base, await baseSources(base, sources), { missingLockfilesAreEmpty: true, gradle: gradle.base });
  const github = new ActionsGitHub(env.fetch, env.githubToken);
  const resolutions = await resolveUses([baseInventory.actions, headInventory.actions], github);
  const baseLocated = [...located(baseInventory), ...actionsLocated(baseInventory.actions, resolutions)];
  const headLocated = [...located(headInventory), ...actionsLocated(headInventory.actions, resolutions)];
  const now = env.now();
  const today = now.toISOString().slice(0, 10);

  // What head adds or changes, with publish times, before the snapshot: young versions' candidates join it.
  const registry = new NpmRegistry(env.fetch);
  const dates = new MavenDates(env.fetch, config.maven.repositories);
  const catalogs = versionCatalogs(config, env, github, registry);
  const problems: string[] = [
    ...bundleFailures(headInventory),
    ...resolutionFailures(baseInventory, config, "base"),
    ...resolutionFailures(headInventory, config, undefined),
  ];
  const changes: ChangedVersion[] = [];
  for (const lockfile of headInventory.npm) {
    const before = baseInventory.npm.find((candidate) => candidate.path === lockfile.path)?.packages ?? [];
    const npm = await npmChanges(before, lockfile.packages, { registry, exceptions, config, now });
    problems.push(...npm.problems.map((problem) => prefixed(headInventory, lockfile.path, problem)));
    changes.push(...npm.changes);
  }
  const maven = await mavenChanges(baseLocated, headLocated, { config, dates });
  problems.push(...maven.problems);
  changes.push(...maven.changes);
  const actions = await actionChanges(baseInventory.actions, headInventory.actions, resolutions, github, config);
  problems.push(...actions.problems);
  changes.push(...actions.changes);
  const merged = mergeChanges(changes);
  const young = merged.filter((change) => isYoung(change, config, now));
  const candidates = await gatherCandidates(young, catalogs, config);

  const snapshot = await takeSnapshot([...baseLocated, ...headLocated], snapshotOptions(config, env, github), [...candidates.versions]);
  const comparison = compareFindings(findingsOf(baseLocated, snapshot), findingsOf(headLocated, snapshot));
  const verdict = comparisonVerdict(comparison, exceptions, snapshot, today);
  problems.push(...(await releaseAgeProblems(young, { snapshot, exceptions, config, now, catalogs, candidates: candidates.byChange })));
  const floorCheck = await checkFloors(floors, headInventory, head);
  return {
    failures: [...verdict.failures, ...problems, ...floorCheck.failures],
    warnings: verdict.warnings,
    notes: [...verdict.notes, ...floorCheck.notes],
    gaps: [...snapshot.gaps, ...actions.gaps],
    osvScannerVersion: version,
    configText,
  };
}

/** One entry per version, with every version it replaces in any lockfile. */
function mergeChanges(changes: ReadonlyArray<ChangedVersion>): ChangedVersion[] {
  const merged = new Map<string, ChangedVersion>();
  for (const change of changes) {
    const key = versionKey(change.pkg);
    const earlier = merged.get(key);
    merged.set(key, earlier === undefined ? change : { ...earlier, replaced: [...new Set([...earlier.replaced, ...change.replaced])] });
  }
  return [...merged.values()];
}

/** What a scan reads before judging: one tree's settings and inventory, every located version, one snapshot over them. */
export interface ScanState {
  readonly settings: Settings;
  readonly inventory: Inventory;
  readonly resolutions: ReadonlyMap<string, Resolution>;
  readonly packages: ReadonlyArray<Located>;
  readonly github: ActionsGitHub;
  readonly snapshot: Snapshot;
  readonly osvScannerVersion: string;
}

export async function readScanState(head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<ScanState> {
  const version = await osvScannerVersion({ binary: env.osvScanner, run: env.run });
  const settings = await readSettings(head);
  const sources = await sourcesOf(head, settings.config);
  const inventory = await readInventory(head, sources, { gradle: gradle.head });
  if (isEmpty(inventory)) throw new Error(`${head.id} has no lockfile, Gradle build or workflow for the gate to check`);
  const github = new ActionsGitHub(env.fetch, env.githubToken);
  const resolutions = await resolveUses([inventory.actions], github);
  const packages = [...located(inventory), ...actionsLocated(inventory.actions, resolutions)];
  const snapshot = await takeSnapshot(packages, snapshotOptions(settings.config, env, github));
  return { settings, inventory, resolutions, packages, github, snapshot, osvScannerVersion: version };
}

export async function runScan(head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<GateOutcome> {
  const { settings, inventory, resolutions, packages, snapshot, osvScannerVersion: version } = await readScanState(head, env, gradle);
  const { config, configText, exceptions, floors } = settings;
  const verdict = scanVerdict(findingsOf(packages, snapshot), exceptions, snapshot, env.now().toISOString().slice(0, 10));
  const npmSources = inventory.npm.flatMap((lockfile) =>
    sourceProblems(lockfile.packages, config.npm.registries).map((problem) => prefixed(inventory, lockfile.path, problem)),
  );
  const floorCheck = await checkFloors(floors, inventory, head);
  return {
    failures: [...verdict.failures, ...bundleFailures(inventory), ...npmSources, ...resolutionFailures(inventory, config, undefined), ...floorCheck.failures],
    warnings: [],
    notes: [...verdict.notes, ...floorCheck.notes],
    gaps: [...snapshot.gaps, ...actionGaps(inventory.actions, resolutions)],
    osvScannerVersion: version,
    configText,
  };
}

/** What makes an inventory incomplete: bundles its lockfiles don't record, and configurations that didn't resolve. */
export function inventoryProblems(inventory: Inventory, config: Config): string[] {
  return [...bundleFailures(inventory), ...resolutionFailures(inventory, config, undefined)];
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
