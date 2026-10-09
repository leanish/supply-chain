/** Prove forced young npm requirements before install; every required target remains exact and independently gated. */
import { type Config, isOwnPackage } from "../../ci/src/config.ts";
import type { Exceptions } from "../../ci/src/exceptions.ts";
import type { Snapshot } from "../../ci/src/snapshot.ts";
import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import { type GateEnvironment, readSettings, snapshotOptions } from "../../ci/src/gate.ts";
import { npmLocation } from "../../ci/src/inventory.ts";
import { isObject } from "../../ci/src/json.ts";
import { lockedPackages, type LockedPackage } from "../../ci/src/npm-lock.ts";
import { NpmRegistry } from "../../ci/src/npm-registry.ts";
import { baseOverrides, directLineConstraints } from "../../ci/src/npm-required-overrides.ts";
import { requiredPeerTargets } from "../../ci/src/npm-required-peers.ts";
import { registryConstraints } from "../../ci/src/npm-required-gate.ts";
import { requiredClosure, requiredPath, requiredVersions, type RequiredTarget, type RequiredNode, type RequiredProof } from "../../ci/src/npm-required.ts";
import { takeSnapshot } from "../../ci/src/take-snapshot.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { compatibleLine, groupsOf } from "../../ci/src/young-fixes.ts";
import { lockfilesOf } from "../../remediation/src/inventories.ts";
import { NpmGraph } from "../../remediation/src/npm-graph.ts";

import { type ChangePlan, lockfileOf } from "./plan.ts";

export interface PlannedRequirement extends RequiredTarget {
  readonly lockfile: string;
  readonly root: RequiredNode;
}

export async function requiredNpmPlan(base: Tree, plan: ChangePlan, env: GateEnvironment): Promise<ChangePlan> {
  if (plan.malware) return plan;
  if (!plan.moves.some((move) => move.ecosystem === "npm" && move.advisories.length > 0)) return plan;
  const locks = await lockfilesOf(base);
  const { config, exceptions } = await readSettings(base);
  const registry = new NpmRegistry(env.fetch);
  const { proofs, targets } = await collectRequirements(base, plan, locks, registry, config, env.now());
  if (targets.length === 0) return plan;
  assertConsistentTargets(targets);
  const baseline = [...locks.values()].flatMap(lockedPackages);
  const snapshot = await takeSnapshot(baseline.map((pkg) => ({ ...pkg, ecosystem: "npm" as const })), snapshotOptions(config, env, new ActionsGitHub(env.fetch, env.githubToken)), requiredVersions(proofs));
  for (const target of targets) await assertSafeTarget(target, baseline, snapshot, registry, exceptions, env.now(), locks, config);
  const notes = [...new Set([...(plan.notes ?? []), ...targets.map((target) => target.reason)])];
  const distinctAdditions = companionMoves(targets, plan, locks);
  const moves = [...plan.moves, ...distinctAdditions];
  const packages = [...new Set(moves.map((move) => `${move.ecosystem}|${move.name}`))].sort();
  const coupled = [...plan.coupled ?? [], ...proofs.map((proof) =>
    [...new Set([proof.root.name, ...proof.targets.map((target) => target.name)].map((name) => `npm|${name}`))].filter((key) => packages.includes(key)))];
  return { ...plan, moves, packages, coupled, requiredNpm: targets, notes };
}

export function requirementLocation(target: PlannedRequirement): string {
  return npmLocation(target.lockfile, target.path);
}

async function collectRequirements(base: Tree, plan: ChangePlan, locks: ReadonlyMap<string, unknown>, registry: NpmRegistry, config: Config, now: Date) {
  const roots = plan.moves.filter((move) => move.ecosystem === "npm" && move.advisories.length > 0);
  const proofs: RequiredProof[] = [];
  const targets: PlannedRequirement[] = [];
  for (const [lockfile, lock] of locks) {
    const overrides = await baseOverrides(base, lockfile);
    const original = (lock as { packages: Record<string, unknown> }).packages;
    const packages = structuredClone(original);
    for (const move of plan.moves.filter((move) => move.ecosystem === "npm")) {
      for (const location of move.locations) {
        const found = lockfileOf(locks, location);
        const entry = packages[found.key];
        if (found.lock !== lock || !isObject(entry)) continue;
        packages[found.key] = { ...entry, version: move.to };
      }
    }
    const verified = new Map(roots.flatMap((root) => root.locations.flatMap((location) => {
      const found = lockfileOf(locks, location);
      return found.lock === lock ? [[found.key, { name: root.name, version: root.to }] as const] : [];
    })));
    const fixed = new Set(verified.keys());
    for (const root of roots) {
      for (const location of root.locations) {
        const found = lockfileOf(locks, location);
        if (found.lock !== lock) continue;
        const proof = await requiredClosure({ name: root.name, version: root.to, path: found.key }, {
          installed: (path) => {
            const actual = packages[path];
            return isObject(actual) && typeof actual["version"] === "string" ? actual["version"] : undefined;
          },
          isOwn: (name) => isOwnPackage(config.ownPackages, { ecosystem: "npm", name }),
          verifiedRoot: (path) => verified.get(path),
          registry, days: config.releaseAgeDays, now,
          placement: (parent, key, peer, optional) => {
            const existing = requiredPath(packages, parent.path, key, peer);
            if (existing !== undefined || optional) return existing;
            // New required packages can be anchored only in the repository root. Nested placement is checked after npm.
            return `node_modules/${key}`;
          },
          incoming: (node) => requiredPeerTargets(node, original, packages, registry, config, now, fixed),
          selected: (target) => { packages[target.path] = { ...(isObject(packages[target.path]) ? packages[target.path] as Record<string, unknown> : {}), name: target.name, version: target.version }; },
          constraints: async (path, name) => [
            ...await registryConstraints(packages, registry, path, name, overrides),
            ...fixed.has(path) ? [] : directLineConstraints(original, path, name, config),
          ],
        });
        if (proof.problems.length > 0) throw new Error(proof.problems.join("; "));
        proofs.push(proof);
        targets.push(...proof.targets.map((target) => ({ ...target, lockfile, root: proof.root })));
      }
    }
  }
  return { proofs, targets };
}

function assertConsistentTargets(targets: ReadonlyArray<PlannedRequirement>): void {
  for (const target of targets) {
    if (targets.some((other) => other.lockfile === target.lockfile && other.path === target.path && other.version !== target.version)) {
      throw new Error(`${target.name}: conflicting required targets at ${target.path}`);
    }
  }
}

async function assertSafeTarget(target: PlannedRequirement, baseline: ReadonlyArray<LockedPackage>, snapshot: Snapshot, registry: NpmRegistry, exceptions: Exceptions, now: Date, locks: ReadonlyMap<string, unknown>, config: Config): Promise<void> {
  const pkg = { ecosystem: "npm" as const, name: target.name, version: target.version };
  const previous = baseline.filter((copy) => copy.name === target.name);
  const inherited = new Set(previous.flatMap((copy) => [...groupsOf(snapshot, { ...pkg, version: copy.version })]));
  if (snapshot.advisories(pkg).some((advisory) => advisory.malicious || !inherited.has(snapshot.group(advisory.id)))) throw new Error(`${target.reason}; lowest required version adds an advisory or malware`);
  const doc = await registry.packument(target.name);
  const manifest = doc.versions[target.version] as { dist?: { integrity?: string; tarball?: string } };
  const identity = await registry.identityProblems({ name: target.name, version: target.version, path: target.path, bundled: false,
    integrity: manifest.dist?.integrity, resolved: manifest.dist?.tarball }, new Map(previous.map((copy) => [copy.version, copy.integrity])), exceptions, now.toISOString().slice(0, 10));
  if (identity.length > 0) throw new Error(`${target.reason}; ${identity.join("; ")}`);
  assertDirectLine(target, locks.get(target.lockfile), config);
}

function assertDirectLine(target: PlannedRequirement, lock: unknown, config: Config): void {
  if (target.path === target.root.path && target.name === target.root.name) return;
  const entries = ((lock as { packages: Record<string, unknown> }).packages);
  for (const [owner, entry] of Object.entries(entries).filter(([path]) => !path.includes("node_modules/"))) {
    if (!isObject(entry)) continue;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (!isObject(entry[field]) || !(target.key in entry[field]) || requiredPath(entries, owner, target.key, false) !== target.path) continue;
      const copy = lockedPackages(lock).find((copy) => copy.path === target.path);
      if (copy !== undefined && compatibleLine(config, { ecosystem: "npm", name: target.name }, copy.version) !== compatibleLine(config, { ecosystem: "npm", name: target.name }, target.version)) throw new Error(`${target.name}: required direct companion would cross its compatible line`);
    }
  }
}

function companionMoves(targets: ReadonlyArray<PlannedRequirement>, plan: ChangePlan, locks: ReadonlyMap<string, unknown>) {
  const additions = targets.flatMap((target) => {
    const graph = new NpmGraph(locks.get(target.lockfile));
    const copy = graph.copies().find((copy) => copy.path === target.path);
    if (copy === undefined || !graph.edgesTo(target.path).some((edge) => edge.declared) || plan.moves.some((move) => move.name === target.name && move.locations.includes(requirementLocation(target)))) return [];
    return [{ ecosystem: "npm" as const, name: target.name, from: copy.version, to: target.version, mechanism: "npm-direct" as const,
      locations: [requirementLocation(target)], advisories: [], major: false, commitSha: undefined, declaredAs: copy.installedAs === copy.name ? undefined : copy.installedAs }];
  });
  const distinctAdditions = [...new Map(additions.map((move) => [JSON.stringify([move.name, move.locations]), move])).values()];
  return distinctAdditions;
}
