/** Direct npm peers move together: fixed rule targets, lowest safe compatible companions, one snapshot. */
import { dirname } from "node:path";

import semver from "semver";

import { directDependencies, lockedPackages, type DirectDependency } from "./npm-lock.ts";
import type { PackageVersion } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import { fixes } from "./young-fixes.ts";

export interface PeerMove {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly locations: ReadonlyArray<string>;
}

export interface PeerAddition extends PeerMove {
  readonly line: string;
  readonly aged: boolean;
  readonly declarations: ReadonlyArray<DirectDependency & { readonly lockfile: string }>;
}

export interface PeerResolution {
  readonly additions: ReadonlyArray<PeerAddition>;
  readonly blocked: ReadonlyArray<{ readonly moves: ReadonlyArray<PeerMove>; readonly reason: string }>;
  /** Package names in each connected set, for an indivisible verification retry. */
  readonly sets: ReadonlyArray<ReadonlyArray<string>>;
}

export interface PeerSources {
  readonly requiredYoung?: (name: string, from: string, lockfile: string, path: string, anchors: ReadonlyArray<PeerMove>) => Promise<string | undefined>;
  versions(name: string): Promise<ReadonlyArray<string> | undefined>;
  manifest(name: string, version: string): Promise<unknown>;
  published(name: string, version: string): Promise<Date | undefined>;
  identity(name: string, from: string, to: string): Promise<ReadonlyArray<string>>;
  line(name: string, version: string): string;
  isOwn(name: string): boolean;
  readonly now: Date;
  readonly releaseAgeDays: number;
}

interface Node {
  readonly key: string;
  readonly lockfile: string;
  readonly path: string;
  readonly name: string;
  readonly from: string;
  readonly location: string;
  readonly declarations: ReadonlyArray<DirectDependency>;
  readonly packages: Record<string, Entry>;
  readonly manifests: Map<string, Entry>;
  readonly candidates: string[];
  problem?: string;
}

interface Entry {
  readonly version?: string;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
}

export interface NpmPeerCandidates {
  readonly bases: ReadonlyArray<PackageVersion>;
  readonly candidates: ReadonlyArray<PackageVersion>;
  resolve(moves: ReadonlyArray<PeerMove>, snapshot: Snapshot): Promise<PeerResolution>;
}

export interface NpmPeerPlanner {
  resolve(moves: ReadonlyArray<PeerMove>): Promise<PeerResolution>;
}

/** Collect connected manifests before taking the batch's snapshot; the registry caches its packuments. */
export async function prepareNpmPeers(locks: ReadonlyMap<string, unknown>, seeds: ReadonlyArray<PackageVersion>, sources: PeerSources): Promise<NpmPeerCandidates> {
  const names = new Set(seeds.filter((pkg) => pkg.ecosystem === "npm").map((pkg) => pkg.name));
  const nodes = nodesOf(locks, names);
  if (names.size === 0) return { bases: [], candidates: [], resolve: async () => ({ additions: [], blocked: [], sets: [] }) };
  // Lockfiles may omit peer metadata. Read each locked manifest too, before discovering incoming constraints.
  const unreadable: string[] = [];
  for (const node of nodes) {
    try {
      node.manifests.set(node.from, manifestOf(await sources.manifest(node.name, node.from), `${node.name}@${node.from}`));
    } catch (err) {
      unreadable.push(`${node.name}@${node.from}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const active = new Set(nodes.filter((node) => names.has(node.name)).map((node) => node.key));
  const loaded = new Set<string>();
  for (;;) {
    for (const node of nodes.filter((node) => active.has(node.key) && !loaded.has(node.key))) {
      await loadCandidates(node, seeds, sources);
      loaded.add(node.key);
    }
    for (const node of nodes) {
      for (const manifest of node.manifests.values()) {
        for (const name of Object.keys(manifest.peerDependencies ?? {})) {
          const target = peerNode(nodes, node, name);
          if (target === undefined || !active.has(node.key) && !active.has(target.key)) continue;
          active.add(node.key);
          active.add(target.key);
        }
      }
    }
    if ([...active].every((key) => loaded.has(key))) break;
  }
  const relevant = unreadable.length > 0 ? nodes.filter((node) => names.has(node.name)) :
    components(nodes.filter((node) => active.has(node.key))).filter((group) => group.some((node) =>
      node.problem !== undefined || [...node.manifests.values()].some((manifest) => Object.keys(manifest.peerDependencies ?? {}).length > 0))).flat();
  return {
    bases: relevant.map((node) => pkg(node, node.from)),
    candidates: relevant.flatMap((node) => [...node.manifests.keys()].map((version) => pkg(node, version))),
    resolve: (moves, snapshot) => unreadable.length === 0 ? resolve(relevant, moves, snapshot, sources) : Promise.resolve({
      additions: [], sets: [], blocked: moves.length === 0 ? [] : [{ moves, reason: `cannot read locked direct-peer metadata: ${unreadable.join("; ")}` }],
    }),
  };
}

function nodesOf(locks: ReadonlyMap<string, unknown>, seeds: ReadonlySet<string>): Node[] {
  const nodes: Node[] = [];
  for (const [lockfile, lock] of locks) {
    const packages = (lock as { packages: Record<string, Entry> }).packages;
    const direct = directDependencies(lock);
    for (const copy of lockedPackages(lock)) {
      const declarations = direct.filter((edge) => edge.path === copy.path);
      if (declarations.length === 0 && !seeds.has(copy.name)) continue;
      const dir = dirname(lockfile);
      nodes.push({
        key: `${lockfile}#${copy.path}`, lockfile, path: copy.path, name: copy.name, from: copy.version,
        location: dir === "." ? copy.path : `${dir}/${copy.path}`, declarations, packages,
        manifests: new Map([[copy.version, packages[copy.path]!]]), candidates: [],
      });
    }
  }
  return nodes.sort((a, b) => a.key.localeCompare(b.key));
}

async function loadCandidates(node: Node, seeds: ReadonlyArray<PackageVersion>, sources: PeerSources): Promise<void> {
  try {
    const listed = node.declarations.length === 0 ? [] : await sources.versions(node.name);
    if (listed === undefined) throw new Error(`the registry doesn't list ${node.name}'s versions completely`);
    const line = sources.line(node.name, node.from);
    node.candidates.push(...listed.filter((version) => semver.valid(version) !== null && version !== node.from &&
      (semver.prerelease(node.from) !== null || semver.prerelease(version) === null) && sources.line(node.name, version) === line).sort(semver.compare));
    const fixed = seeds.filter((candidate) => candidate.ecosystem === "npm" && candidate.name === node.name).map((candidate) => candidate.version);
    for (const version of new Set([...node.candidates, ...fixed])) {
      if (version === node.from) continue;
      node.manifests.set(version, manifestOf(await sources.manifest(node.name, version), `${node.name}@${version}`));
    }
  } catch (err) {
    node.problem = err instanceof Error ? err.message : String(err);
  }
}

function manifestOf(value: unknown, label: string): Entry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`no manifest for ${label}`);
  const entry = value as Entry;
  const peers = entry.peerDependencies;
  if (peers !== undefined && (typeof peers !== "object" || peers === null || Array.isArray(peers) ||
    Object.values(peers).some((range) => typeof range !== "string" || semver.validRange(range) === null))) {
    throw new Error(`invalid peer ranges in ${label}`);
  }
  return entry;
}

function pkg(node: Node, version: string): PackageVersion {
  return { ecosystem: "npm", name: node.name, version };
}

/** A peer is resolved alongside the package, never in that package's private node_modules. */
function peerPath(node: Node, name: string): string | undefined {
  const marker = node.path.lastIndexOf("node_modules/");
  let dir = node.path.slice(0, marker).replace(/\/$/, "");
  for (;;) {
    const path = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (node.packages[path] !== undefined) return path;
    if (dir === "") return undefined;
    const cut = dir.lastIndexOf("/node_modules/");
    dir = cut === -1 ? dirname(dir) : dir.slice(0, cut);
    if (dir === ".") dir = "";
  }
}

function peerNode(nodes: ReadonlyArray<Node>, owner: Node, name: string): Node | undefined {
  const path = peerPath(owner, name);
  return nodes.find((node) => node.lockfile === owner.lockfile && node.path === path);
}

function components(nodes: ReadonlyArray<Node>): Node[][] {
  const remaining = new Set(nodes);
  const result: Node[][] = [];
  while (remaining.size > 0) {
    const group = new Set([remaining.values().next().value!]);
    for (;;) {
      const size = group.size;
      for (const node of nodes) {
        for (const manifest of node.manifests.values()) {
          for (const name of Object.keys(manifest.peerDependencies ?? {})) {
            const peer = peerNode(nodes, node, name);
            if (peer === undefined || !group.has(node) && !group.has(peer)) continue;
            group.add(node);
            group.add(peer);
          }
        }
      }
      if (group.size === size) break;
    }
    for (const node of group) remaining.delete(node);
    result.push([...group]);
  }
  return result;
}

async function resolve(nodes: ReadonlyArray<Node>, moves: ReadonlyArray<PeerMove>, snapshot: Snapshot, sources: PeerSources): Promise<PeerResolution> {
  const additions: PeerAddition[] = [];
  const blocked: Array<{ moves: PeerMove[]; reason: string }> = [];
  const sets: string[][] = [];
  for (const group of components(nodes)) {
    const anchors = moves.filter((move) => group.some((node) => matches(node, move)));
    if (anchors.length === 0) continue;
    sets.push([...new Set(group.map((node) => node.name))].sort());
    const options = new Map<string, string[]>();
    const reasons: string[] = [];
    for (const node of group) {
      const found = await optionsFor(node, anchors, snapshot, sources);
      options.set(node.key, found.versions);
      reasons.push(...found.problems);
    }
    // Fixed targets first prune incompatible companions immediately; remaining copies keep a deterministic order.
    const order = [...group].sort((a, b) => Number(anchors.some((move) => matches(b, move))) - Number(anchors.some((move) => matches(a, move))) || a.key.localeCompare(b.key));
    const solved = reasons.length === 0 ? solve(order, options) : undefined;
    if (solved === undefined) {
      const detail = [...reasons, ...lockedConflicts(group, anchors), "no eligible compatible combination satisfies all peer ranges"].join("; ");
      blocked.push({ moves: anchors, reason: `no safe aged compatible direct-peer set for ${anchors.map((move) => `${move.name}@${move.to}`).join(", ")}: ${detail}` });
      continue;
    }
    for (const node of group) {
      const to = solved.get(node.key)!;
      if (to === node.from || anchors.some((move) => matches(node, move))) continue;
      additions.push({ name: node.name, from: node.from, to, line: sources.line(node.name, to), aged: await isAged(node.name, to, sources), locations: [node.location],
        declarations: node.declarations.map((declaration) => ({ ...declaration, lockfile: node.lockfile })) });
    }
  }
  return { additions, blocked, sets };
}

async function optionsFor(node: Node, anchors: ReadonlyArray<PeerMove>, snapshot: Snapshot, sources: PeerSources) {
  const targets = [...new Set(anchors.filter((move) => matches(node, move)).map((move) => move.to))];
  const problems = node.problem === undefined ? [] : [node.problem];
  if (targets.length > 1) problems.push(`${node.name} has conflicting planned targets ${targets.join(", ")}`);
  let forced: string | undefined;
  try {
    if (targets.length === 0) forced = await sources.requiredYoung?.(node.name, node.from, node.lockfile, node.path, anchors);
  } catch (error) {
    return { versions: [], problems: [...problems, `${node.name}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const versions: string[] = [];
  for (const version of targets.length > 0 ? targets : [node.from, ...node.candidates]) {
    if (!node.manifests.has(version)) continue;
    try {
      if (version !== node.from && !fixes(snapshot, pkg(node, node.from), node.from, [], version)) continue;
      // Rule targets already satisfy their age rule (security fixes may be young); companions must be aged.
      if (targets.length === 0 && version !== node.from && !sources.isOwn(node.name)) {
        const published = await sources.published(node.name, version);
        if (published === undefined || sources.now.getTime() - published.getTime() < sources.releaseAgeDays * 86_400_000) {
          if (version !== forced) continue;
        }
      }
      if (version !== node.from && (await sources.identity(node.name, node.from, version)).length > 0) continue;
      versions.push(version);
    } catch (err) {
      problems.push(`${node.name}@${version}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (versions.length === 0) problems.push(`${node.name}: no candidate passes age, advisory and identity checks`);
  return { versions, problems };
}

/** Describe the concrete constraints that made the original fixed moves need companions. */
function lockedConflicts(nodes: ReadonlyArray<Node>, anchors: ReadonlyArray<PeerMove>): string[] {
  const versionOf = (node: Node) => anchors.find((move) => matches(node, move))?.to ?? node.from;
  const problems: string[] = [];
  for (const node of nodes) {
    const version = versionOf(node);
    for (const [name, range] of Object.entries(node.manifests.get(version)?.peerDependencies ?? {})) {
      const peer = peerNode(nodes, node, name);
      if (peer === undefined || semver.satisfies(versionOf(peer), range, { includePrerelease: true })) continue;
      problems.push(`${node.name}@${version} requires peer ${name} ${range}, not ${versionOf(peer)}`);
    }
  }
  return problems;
}

const matches = (node: Node, move: PeerMove) => node.name === move.name && node.from === move.from && move.locations.includes(node.location);

function solve(nodes: ReadonlyArray<Node>, options: ReadonlyMap<string, ReadonlyArray<string>>, chosen = new Map<string, string>()): Map<string, string> | undefined {
  if (chosen.size === nodes.length) return chosen;
  const node = nodes[chosen.size]!;
  for (const version of options.get(node.key) ?? []) {
    const next = new Map(chosen).set(node.key, version);
    if (!consistent(nodes, next)) continue;
    const solved = solve(nodes, options, next);
    if (solved !== undefined) return solved;
  }
  return undefined;
}

function consistent(nodes: ReadonlyArray<Node>, chosen: ReadonlyMap<string, string>): boolean {
  for (const node of nodes) {
    const version = chosen.get(node.key);
    if (version === undefined) continue;
    const manifest = node.manifests.get(version)!;
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const peer = peerNode(nodes, node, name);
      // Missing or purely transitive peers stay with npm resolution and compare; this planner aligns existing directs.
      if (peer === undefined || !chosen.has(peer.key)) continue;
      const installed = chosen.get(peer.key);
      // Do not repair unrelated peer problems that already existed in the base.
      if (version === node.from && installed === peer.from) continue;
      if (installed === undefined && manifest.peerDependenciesMeta?.[name]?.optional === true) continue;
      if (installed === undefined || !semver.satisfies(installed, range, { includePrerelease: true })) return false;
    }
  }
  return true;
}

async function isAged(name: string, version: string, sources: PeerSources): Promise<boolean> {
  if (sources.isOwn(name)) return false;
  const published = await sources.published(name, version);
  return published !== undefined && sources.now.getTime() - published.getTime() >= sources.releaseAgeDays * 86_400_000;
}
