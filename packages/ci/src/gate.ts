/**
 * The two runs of the gate:
 *   - `compare` (a pull request): base and head inventories, one advisory
 *     snapshot for both, and the checks on what head adds or changes;
 *   - `scan` (the default branch, on push and daily): every finding in one
 *     tree fails unless excepted.
 * Config and exceptions come from head: they're part of what would land.
 */
import { type Config, DEFAULT_CONFIG, parseConfig } from "./config.ts";
import { type Exceptions, NO_EXCEPTIONS, parseExceptions } from "./exceptions.ts";
import { compareFindings, findingsOf } from "./findings.ts";
import type { Fetch } from "./http.ts";
import { type Inventory, located, readInventory } from "./inventory.ts";
import { npmChangeProblems } from "./npm-changes.ts";
import { sourceProblems } from "./npm-lock.ts";
import { NpmRegistry } from "./npm-registry.ts";
import { osvScannerVersion } from "./osv-scanner.ts";
import { comparisonVerdict, scanVerdict } from "./policy.ts";
import type { RunProcess } from "./process.ts";
import { MAVEN_CENTRAL } from "./source-repos.ts";
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

interface Settings {
  readonly config: Config;
  readonly configText: string | undefined;
  readonly exceptions: Exceptions;
}

async function readSettings(head: Tree): Promise<Settings> {
  const configText = await head.read(CONFIG_PATH);
  const exceptionsText = await head.read(EXCEPTIONS_PATH);
  return {
    config: configText === undefined ? DEFAULT_CONFIG : parseConfig(parseJson(configText, CONFIG_PATH)),
    configText,
    exceptions: exceptionsText === undefined ? NO_EXCEPTIONS : parseExceptions(parseJson(exceptionsText, EXCEPTIONS_PATH)),
  };
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
    sourceRepos: { fetch: env.fetch, overrides: config.repositories, mavenRepositories: [MAVEN_CENTRAL] },
    repositoryAdvisories: { fetch: env.fetch, token: env.githubToken },
    fetch: env.fetch,
    now: env.now,
  };
}

export async function runCompare(base: Tree, head: Tree, env: GateEnvironment): Promise<GateOutcome> {
  const version = await osvScannerVersion({ binary: env.osvScanner, run: env.run });
  const { config, configText, exceptions } = await readSettings(head);
  const headInventory = await readInventory(head, config);
  const baseInventory = await readInventory(base, config, { missingLockfilesAreEmpty: true });
  const baseLocated = located(baseInventory);
  const headLocated = located(headInventory);
  const snapshot = await takeSnapshot([...baseLocated, ...headLocated], snapshotOptions(config, env));
  const now = env.now();
  const today = now.toISOString().slice(0, 10);
  const comparison = compareFindings(findingsOf(baseLocated, snapshot), findingsOf(headLocated, snapshot));
  const verdict = comparisonVerdict(comparison, exceptions, snapshot, today);
  const registry = new NpmRegistry(env.fetch);
  const changeProblems: string[] = [...bundleFailures(headInventory)];
  for (const lockfile of headInventory.npm) {
    const before = baseInventory.npm.find((candidate) => candidate.path === lockfile.path)?.packages ?? [];
    const problems = await npmChangeProblems(before, lockfile.packages, { registry, snapshot, exceptions, config, now });
    changeProblems.push(...problems.map((problem) => prefixed(headInventory, lockfile.path, problem)));
  }
  return {
    failures: [...verdict.failures, ...changeProblems],
    warnings: verdict.warnings,
    notes: verdict.notes,
    gaps: snapshot.gaps,
    osvScannerVersion: version,
    configText,
  };
}

export async function runScan(head: Tree, env: GateEnvironment): Promise<GateOutcome> {
  const version = await osvScannerVersion({ binary: env.osvScanner, run: env.run });
  const { config, configText, exceptions } = await readSettings(head);
  const inventory = await readInventory(head, config);
  const packages = located(inventory);
  const snapshot = await takeSnapshot(packages, snapshotOptions(config, env));
  const verdict = scanVerdict(findingsOf(packages, snapshot), exceptions, snapshot, env.now().toISOString().slice(0, 10));
  const sources = inventory.npm.flatMap((lockfile) =>
    sourceProblems(lockfile.packages, config.npm.registries).map((problem) => prefixed(inventory, lockfile.path, problem)),
  );
  return {
    failures: [...verdict.failures, ...bundleFailures(inventory), ...sources],
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

/** Names the lockfile when there's more than one. */
function prefixed(inventory: Inventory, lockfile: string, problem: string): string {
  return inventory.npm.length > 1 ? `${lockfile}: ${problem}` : problem;
}
