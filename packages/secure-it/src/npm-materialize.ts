/** Apply security npm moves mechanically in an exported base; induced transitives remain npm's, judged by compare. */
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { FLOORS_PATH, parseFloors } from "../../ci/src/floors.ts";
import type { Tree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { exportCommit } from "../../remediation/src/git-copies.ts";
import { lockfilesOf } from "../../remediation/src/inventories.ts";
import { writeLocalFile } from "../../remediation/src/local-files.ts";
import { formatManifest } from "../../remediation/src/manifest-format.ts";
import { withSpec } from "../../remediation/src/manifest-spec.ts";
import { manifestPath, resolveExact } from "../../remediation/src/npm-exact.ts";
import { NpmGraph, rewriteSpec } from "../../remediation/src/npm-graph.ts";
import { repositoryOverrides } from "../../remediation/src/npm-overrides.ts";
import { requireNpmExcludes } from "../../remediation/src/npm-version.ts";
import { pinnedManifests, type Pin } from "../../remediation/src/npm-pins.ts";
import { runSandboxed } from "../../remediation/src/sandboxed.ts";

import type { PlannedRequirement } from "./npm-required-plan.ts";
import { type ChangePlan, lockfileOf, type PlannedMove } from "./plan.ts";

type NpmCommand = (cwd: string, args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string; stderr: string }>;
type Manifest = Record<string, unknown>;

export async function materializeOnBase(context: ToolRunContext, base: Tree, plan: ChangePlan, exclude: ReadonlyArray<string>): Promise<ReadonlyMap<string, string>> {
  if (!plan.moves.some((move) => move.ecosystem === "npm")) return new Map();
  const copy = await exportCommit(context.workingCopy, base.id);
  try {
    return await materializeInCopy(context, copy.dir, base, plan, exclude, (cwd, args) =>
      runSandboxed(context.isolation, { workingCopy: { ...context.workingCopy, path: cwd }, command: ["npm", ...args] }));
  } finally {
    await copy.remove();
  }
}

/** Replaceable process boundary for tests; production always runs under the repository sandbox. */
export async function materializeInCopy(context: Pick<ToolRunContext, "releaseAgeDays" | "now">, dir: string, base: Tree, plan: ChangePlan, exclude: ReadonlyArray<string>, npm: NpmCommand): Promise<ReadonlyMap<string, string>> {
  const locks = await lockfilesOf(base);
  const files = new Map<string, string>();
  let floorsText = await base.read(FLOORS_PATH);
  for (const [lockfile, lock] of locks) {
    const moves = plan.moves.filter((move) => move.ecosystem === "npm" && move.locations.some((location) => lockfileOf(locks, location).lock === lock));
    if (moves.length === 0) continue;
    const result = await materializeLock({ context, dir, base, exclude, npm }, locks, lockfile, lock, moves, floorsText, plan.requiredNpm?.filter((target) => target.lockfile === lockfile) ?? []);
    floorsText = result.floorsText;
    for (const [path, text] of result.files) files.set(path, text);
  }
  if (floorsText !== await base.read(FLOORS_PATH) && floorsText !== undefined) {
    await writeLocalFile(dir, FLOORS_PATH, floorsText);
    files.set(FLOORS_PATH, floorsText);
  }
  return files;
}

interface MaterializationInputs {
  readonly context: Pick<ToolRunContext, "releaseAgeDays" | "now">;
  readonly dir: string;
  readonly base: Tree;
  readonly exclude: ReadonlyArray<string>;
  readonly npm: NpmCommand;
}

async function materializeLock(inputs: MaterializationInputs, locks: ReadonlyMap<string, unknown>, lockfile: string, lock: unknown, moves: ReadonlyArray<PlannedMove>, floorsText: string | undefined, required: ReadonlyArray<PlannedRequirement>) {
  const { context, dir, base, exclude, npm } = inputs;
  const files = new Map<string, string>();
  const root = dirname(lockfile);
  const cwd = join(dir, root);
  await validateLock(cwd, lockfile);
  await requireNpmExcludes(npm, cwd, exclude, "young security targets, young locked base versions or own scopes");
  const graph = new NpmGraph(lock);
  const texts = await manifestTexts(graph, base, root);
  const plannedTargets = planDeclarations(graph, moves, locks, lock, texts);
  floorsText = planOverrides(graph, plannedTargets, texts, root, floorsText, context.now);
  const manifests = new Map([...texts].map(([owner, text]) => [owner, JSON.parse(text) as Manifest]));
  const pinGraph = requiredPinGraph(lock, required, manifests);
  const pins: Pin[] = pinGraph.copies().flatMap((copy) => {
    const move = plannedTargets.get(copy.path);
    const target = required.find((target) => target.path === copy.path);
    if (move !== undefined && target !== undefined && move.to !== target.version) throw new Error(`${copy.name}: planned security target conflicts with required ${target.version}`);
    return move !== undefined || target !== undefined || graph.edgesTo(copy.path).some((edge) => edge.declared)
      ? [{ copy, target: move?.to ?? target?.version ?? copy.version }] : [];
  });
  const runInstall = async () => {
    const result = await npm(cwd, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--min-release-age=${context.releaseAgeDays}`, ...exclude.map((name) => `--min-release-age-exclude=${name}`)]);
    if (result.code !== 0) throw new Error(`npm install in ${root} failed: ${result.stderr.trim()}`);
  };
  await resolveExact(cwd, texts, pinnedManifests(pinGraph, pins, manifests, repositoryOverrides(manifests.get(""))), runInstall, runInstall);
  const final = await readFile(join(dir, lockfile), "utf8");
  const head = new NpmGraph(JSON.parse(final));
  assertLanding(graph, head, plannedTargets);
  for (const target of required) {
    if (head.packages[target.path]?.version !== target.version) throw new Error(`${target.name} at ${target.path} did not keep its lowest required target ${target.version}`);
  }
  // Include unchanged manifests too: the agent must leave every computed npm dependency file intact.
  for (const [owner, text] of texts) files.set(join(root, manifestPath(owner)), text);
  files.set(lockfile, final);
  return { files, floorsText };
}

async function validateLock(cwd: string, lockfile: string): Promise<void> {
  if (!["package-lock.json", "npm-shrinkwrap.json"].includes(basename(lockfile))) throw new Error(`unsupported lockfile ${lockfile}`);
  if (basename(lockfile) === "package-lock.json") {
    try {
      await lstat(join(cwd, "npm-shrinkwrap.json"));
      throw new Error(`${lockfile} is shadowed by npm-shrinkwrap.json`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

async function manifestTexts(graph: NpmGraph, base: Tree, root: string): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const owner of Object.keys(graph.packages).filter((path) => !path.includes("node_modules/") && graph.packages[path]?.link !== true)) {
    const path = join(root, manifestPath(owner));
    const text = await base.read(path);
    if (text === undefined) throw new Error(`missing ${path}`);
    texts.set(owner, text);
  }
  return texts;
}

function planDeclarations(graph: NpmGraph, moves: ReadonlyArray<PlannedMove>, locks: ReadonlyMap<string, unknown>, lock: unknown, texts: Map<string, string>): Map<string, PlannedMove> {
  const plannedTargets = new Map<string, PlannedMove>();
  for (const move of moves) {
    for (const location of move.locations) {
      if (lockfileOf(locks, location).lock !== lock) continue;
      const { key } = lockfileOf(locks, location);
      const previous = plannedTargets.get(key);
      if (previous !== undefined && previous.to !== move.to) throw new Error(`${location}: conflicting exact targets`);
      plannedTargets.set(key, move);
      if (move.mechanism === "npm-direct") {
        const edges = graph.edgesTo(key).filter((edge) => edge.declared);
        if (edges.length === 0) throw new Error(`${location}: no direct declaration to move`);
        for (const edge of edges) {
          const spec = rewriteSpec(edge.spec, move.to);
          if (spec === undefined) throw new Error(`${edge.key}: cannot rewrite '${edge.spec}' to ${move.to}`);
          texts.set(edge.from, withSpec(texts.get(edge.from)!, edge.key, edge.spec, spec, manifestPath(edge.from)));
        }
      }
    }
  }
  return plannedTargets;
}

function planOverrides(graph: NpmGraph, plannedTargets: ReadonlyMap<string, PlannedMove>, texts: Map<string, string>, root: string, floorsText: string | undefined, now: Date): string | undefined {
  for (const [key, move] of plannedTargets) {
    if (move.mechanism !== "npm-override") continue;
    const copy = graph.copies().find((copy) => copy.path === key);
    if (copy === undefined) throw new Error(`${key}: missing planned npm copy`);
    if (copy.installedAs !== copy.name) throw new Error(`unsupported npm override placement: ${key} is an alias; the gate cannot record an alias floor selector`);
    const manifest = JSON.parse(texts.get("")!) as Manifest;
    const overrides = (manifest["overrides"] ??= {}) as Record<string, unknown>;
    const cut = key.lastIndexOf("/node_modules/");
    const parent = cut === -1 ? undefined : graph.nameAt(key.slice(0, cut));
    const selector = parent === undefined ? [copy.installedAs] : [parent, copy.installedAs];
    let rule = overrides;
    for (const segment of selector.slice(0, -1)) {
      const current = rule[segment];
      if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) throw new Error(`${key}: an existing override cannot be narrowed safely`);
      rule = (rule[segment] ??= {}) as Record<string, unknown>;
    }
    rule[selector.at(-1)!] = copy.installedAs === copy.name ? move.to : `npm:${copy.name}@${move.to}`;
    texts.set("", formatManifest(texts.get("")!, manifest));
    floorsText = securityFloor(floorsText, move, join(root, "package.json"), selector, now);
  }
  return floorsText;
}

function assertLanding(graph: NpmGraph, head: NpmGraph, plannedTargets: ReadonlyMap<string, PlannedMove>): void {
  for (const [path, move] of plannedTargets) {
    if (head.packages[path]?.version !== move.to) throw new Error(`${move.name} at ${path} did not land exactly at ${move.to}`);
  }
  for (const edge of graph.declaredEdges()) {
    const previous = graph.copies().find((copy) => copy.path === edge.to);
    if (previous === undefined) continue;
    const target = plannedTargets.get(previous.path)?.to ?? previous.version;
    const landed = head.declaredEdges().find((candidate) => candidate.from === edge.from && candidate.key === edge.key);
    if (landed?.to === undefined || head.packages[landed.to]?.version !== target) throw new Error(`${edge.key} in ${manifestPath(edge.from)} did not keep its exact target ${target}`);
  }
}

function securityFloor(text: string | undefined, move: PlannedMove, declaredIn: string, selector: string[], now: Date): string {
  const record = text === undefined ? { floors: [] as Record<string, unknown>[] } : JSON.parse(text) as { floors: Record<string, unknown>[] };
  const parsed = parseFloors(record);
  const index = parsed.findIndex((floor) => floor.ecosystem === "npm" && floor.package === move.name && floor.declaredIn === declaredIn &&
    floor.overridePaths.some((path) => JSON.stringify(path) === JSON.stringify(selector)));
  const existing = index === -1 ? undefined : record.floors[index];
  if (existing !== undefined) {
    if (parsed[index]!.overridePaths.length !== 1) throw new Error(`${move.name}: multiple existing floor selectors need a joint planned update`);
    if (existing["purpose"] !== "security") throw new Error(`${move.name}: compatibility floors cannot change`);
    existing["version"] = move.to;
    existing["advisories"] = [...new Set([...(existing["advisories"] as string[]), ...move.advisories])];
  } else {
    record.floors.push({ ecosystem: "npm", package: move.name, version: move.to, declaredIn, selector: [selector], purpose: "security", advisories: [...move.advisories], reason: `Security fix for ${move.advisories.join(", ")}`, added: now.toISOString().slice(0, 10) });
  }
  parseFloors(record);
  return formatManifest(text ?? "{}\n", record);
}

/** A synthetic peer edge requests the shared exact-declaration machinery, without changing any persisted graph. */
function requiredPinGraph(lock: unknown, required: ReadonlyArray<PlannedRequirement>, manifests: ReadonlyMap<string, Manifest>): NpmGraph {
  const packages = structuredClone((lock as { packages: Record<string, unknown> }).packages);
  for (const [index, target] of required.entries()) {
    const suffix = `node_modules/${target.key}`;
    const owner = target.path === suffix ? "" : target.path.endsWith(`/${suffix}`) ? target.path.slice(0, -(suffix.length + 1)) : undefined;
    if (owner === undefined || !manifests.has(owner) || owner.includes("node_modules/")) throw new Error(`${target.name}: unsupported required-dependency placement ${target.path}`);
    packages[target.path] ??= { name: target.name, version: target.version };
    const prefix = owner === "" ? "" : `${owner}/`;
    const anchor = `${prefix}node_modules/.required-proof-${index}`;
    if (packages[anchor] !== undefined) throw new Error(`unsupported required-dependency anchor collision ${anchor}`);
    packages[anchor] = { version: "0.0.0", peerDependencies: { [target.key]: target.name === target.key ? target.version : `npm:${target.name}@${target.version}` } };
  }
  return new NpmGraph({ packages });
}
