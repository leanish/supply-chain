/** Reconstruct required-dependency age evidence from actual lockfile placements and registry requirements. */
import { baseOverrides, directLineConstraints, overrideConstraints } from "./npm-required-overrides.ts";
import { requiredPeerTargets } from "./npm-required-peers.ts";
import { type Config, isOwnPackage } from "./config.ts";
import { isObject } from "./json.ts";
import type { Inventory } from "./inventory.ts";
import type { NpmRegistry } from "./npm-registry.ts";
import { type RequiredProof, requiredClosure, requiredPath, requirementSpec, requirements } from "./npm-required.ts";
import { versionKey } from "./package-version.ts";
import type { ChangedVersion } from "./release-age.ts";
import type { Tree } from "./tree.ts";
import { type Candidates, type VersionCatalog, youngFixProblem } from "./young-fixes.ts";
import type { Snapshot } from "./snapshot.ts";

/** `changes` contains independently verified roots only; ordinary upgrades remain untrusted. */
export async function gatherRequiredProofs(changes: ReadonlyArray<ChangedVersion>, base: Tree, head: Tree, inventory: Inventory, registry: NpmRegistry, config: Config, now: Date): Promise<RequiredProof[]> {
  const proofs: RequiredProof[] = [];
  for (const lock of inventory.npm) {
    const text = await head.read(lock.path);
    if (text === undefined) continue;
    const baseText = await base.read(lock.path);
    const basePackages = baseText === undefined ? {} : (JSON.parse(baseText) as { packages: Record<string, unknown> }).packages;
    const overrides = await baseOverrides(base, lock.path);
    const packages = (JSON.parse(text) as { packages: Record<string, unknown> }).packages;
    const roots = lock.packages.filter((copy) => !copy.bundled && changes.some((change) =>
      change.pkg.ecosystem === "npm" && change.replaced.length > 0 && copy.name === change.pkg.name && copy.version === change.pkg.version));
    const fixed = new Set(roots.map((copy) => copy.path));
    for (const change of changes.filter((change) => change.pkg.ecosystem === "npm" && change.replaced.length > 0)) {
      for (const copy of lock.packages.filter((copy) => copy.name === change.pkg.name && copy.version === change.pkg.version && !copy.bundled)) {
        // The caller establishes every security root before gathering the joint closure.
        // Ordinary head upgrades remain at base; they cannot manufacture necessity.
        const trusted = structuredClone(basePackages);
        for (const root of roots) trusted[root.path] = packages[root.path];
        const proof = await requiredClosure({ name: copy.name, version: copy.version, path: copy.path }, {
          installed: (path) => {
            const previous = trusted[path];
            return isObject(previous) && typeof previous["version"] === "string" ? previous["version"] : undefined;
          },
          isOwn: (name) => isOwnPackage(config.ownPackages, { ecosystem: "npm", name }),
          registry, days: config.releaseAgeDays, now,
          placement: (parent, key, peer) => requiredPath(packages, parent.path, key, peer),
          selected: (target) => {
            const actual = packages[target.path];
            trusted[target.path] = { ...(isObject(actual) ? actual : {}), name: target.name, version: target.version };
          },
          incoming: (node) => requiredPeerTargets(node, basePackages, trusted, registry, config, now, fixed),
          constraints: async (path, name) => [
            ...await registryConstraints(trusted, registry, path, name, overrides),
            ...fixed.has(path) ? [] : directLineConstraints(basePackages, path, name, config),
          ],
        });
        const landing = proof.targets.flatMap((target) => {
          const actual = packages[target.path];
          return isObject(actual) && actual["version"] === target.version ? []
            : [`${target.name} at ${target.path} must land at required version ${target.version}`];
        });
        proofs.push({ ...proof, problems: [...proof.problems, ...landing] });
      }
    }
  }
  return proofs;
}

/** Only independently rule-picked security roots may influence the joint constraint graph. */
export async function verifiedSecurityRoots(changes: ReadonlyArray<ChangedVersion>, candidates: Candidates, snapshot: Snapshot, catalog: VersionCatalog, config: Config, now: Date): Promise<ChangedVersion[]> {
  const roots: ChangedVersion[] = [];
  for (const change of changes) {
    if (await rootProblem(change, candidates, snapshot, catalog, config, now) === undefined) roots.push(change);
  }
  return roots;
}

async function rootProblem(change: ChangedVersion, candidates: Candidates, snapshot: Snapshot, catalog: VersionCatalog, config: Config, now: Date): Promise<string | undefined> {
  const own = isOwnPackage(config.ownPackages, change.pkg);
  const rootCatalog = own ? { versions: catalog.versions.bind(catalog), published: async () => new Date(0) } : catalog;
  return youngFixProblem(change, candidates.byChange.get(versionKey(change.pkg)) ?? new Map(), snapshot, rootCatalog, own ? { ...config, releaseAgeDays: 0 } : config, now);
}

export async function verifiedRequiredProofs(proofs: ReadonlyArray<RequiredProof>, changes: ReadonlyArray<ChangedVersion>, candidates: Candidates, snapshot: Snapshot, catalog: VersionCatalog, config: Config, now: Date) {
  const versions = new Set<string>();
  const problems: string[] = [];
  const notes: string[] = [];
  for (const proof of proofs) {
    const pkg = { ecosystem: "npm" as const, name: proof.root.name, version: proof.root.version };
    const change = changes.find((change) => versionKey(change.pkg) === versionKey(pkg));
    if (change === undefined) continue;
    const problem = await rootProblem(change, candidates, snapshot, catalog, config, now);
    if (problem !== undefined) continue;
    problems.push(...proof.problems);
    // A partial closure never grants an exemption, even when the error happened after the first child.
    if (proof.problems.length > 0) continue;
    for (const target of proof.targets) {
      if (target.exempt) versions.add(versionKey({ ecosystem: "npm", name: target.name, version: target.version }));
      notes.push(target.reason);
    }
  }
  return { versions, problems, notes: [...new Set(notes)] };
}

/** Registry requirements of trusted installed parents and baseline overrides constrain a shared copy. */
export async function registryConstraints(packages: Readonly<Record<string, unknown>>, registry: NpmRegistry, path: string, name: string, overrides: Readonly<Record<string, unknown>> = {}): Promise<string[]> {
  const ranges = overrideConstraints(overrides, packages, path, name);
  for (const [owner, raw] of Object.entries(packages)) {
    if (!isObject(raw) || raw["link"] === true) continue;
    const installed = owner.includes("node_modules/");
    // PR declarations can be narrowed arbitrarily; only registry parents establish necessity.
    if (!installed) continue;
    let manifest = raw;
    if (installed && typeof raw["version"] === "string") {
      const parentName = typeof raw["name"] === "string" ? raw["name"] : owner.slice(owner.lastIndexOf("node_modules/") + "node_modules/".length);
      const found = (await registry.packument(parentName)).versions[raw["version"]];
      if (!isObject(found)) throw new Error(`missing constraint manifest for ${parentName}@${raw["version"]}`);
      manifest = found;
    }
    for (const edge of requirements(manifest)) {
      if (requiredPath(packages, owner, edge.key, edge.peer) !== path) continue;
      const spec = requirementSpec(edge.key, edge.spec);
      if (spec.name === name) ranges.push(spec.range);
    }
  }
  return ranges;
}
