/**
 * The gate's proof that a young npm carrier version is a bundled security
 * fix (`bundle-fix`), reconstructed from the comparison's own trees, never
 * from a PR's plan: at a lockfile path where base had the carrier at R and
 * head has it at V,
 *   1. both archives are read from the registry, authenticated against the
 *      integrity each lockfile records (head's must also be the registry's),
 *      and each lockfile's bundled entries under that path must be exactly
 *      what its archive ships;
 *   2. the targets are the bundled package + advisory groups R's bundle has
 *      and V's doesn't;
 *   3. V must be what the carrier rule (`carrier-fixes.ts`) picks for those
 *      targets among the carrier's versions above R.
 * Any part that can't be established (an unreadable archive, a budget, an
 * unknown publish time) leaves V unjustified, with the reason.
 *
 * The targets include the carrier's own advisory groups R has and V doesn't,
 * so a version fixing both is proved as the combined choice secure-it makes.
 * Every head copy of V must be such an occurrence and pass: a copy elsewhere
 * has no evidence of its own.
 *
 * A carrier proved this way doesn't seed required-dependency proofs: a young
 * non-bundled dependency it needs stays unjustified, and the comparison fails.
 */
import { candidateVersions, groupsOf, targetsOf, type VersionCatalog } from "./young-fixes.ts";
import { chooseCarrier, describe, removedTargets, registryIntegrity } from "./carrier-fixes.ts";
import type { Config } from "./config.ts";
import { isOwnPackage } from "./config.ts";
import type { Inventory } from "./inventory.ts";
import { type BundleReader, bundleMismatches } from "./npm-bundles.ts";
import type { NpmRegistry } from "./npm-registry.ts";
import type { PackageVersion } from "./package-version.ts";
import { versionKey } from "./package-version.ts";
import type { ChangedVersion } from "./release-age.ts";
import type { Snapshot } from "./snapshot.ts";

export interface BundleFixInputs {
  readonly base: Inventory;
  readonly head: Inventory;
  readonly reader: BundleReader;
  readonly registry: NpmRegistry;
  readonly catalog: VersionCatalog;
  readonly config: Config;
  readonly now: Date;
  readonly scan: (packages: ReadonlyArray<PackageVersion>) => Promise<Snapshot>;
}

/** Per young npm version (`versionKey`) that replaces a carrier in place: undefined when proved, else why not. */
export async function bundleFixProofs(young: ReadonlyArray<ChangedVersion>, inputs: BundleFixInputs): Promise<ReadonlyMap<string, string | undefined>> {
  const proofs = new Map<string, string | undefined>();
  for (const change of young) {
    if (change.pkg.ecosystem !== "npm" || change.replaced.length === 0) continue;
    const found = occurrences(change, inputs);
    if (found.length === 0) continue;
    // Every head copy of the version needs its own evidence: one proved copy can't vouch for another.
    if (found.some((occurrence) => occurrence === undefined)) {
      proofs.set(versionKey(change.pkg), `${change.pkg.name}@${change.pkg.version} is also where it replaces no carrier copy in place`);
      continue;
    }
    const reasons: string[] = [];
    for (const occurrence of found as Occurrence[]) {
      const why = await proofProblem(change.pkg, occurrence, inputs).catch((error: unknown) =>
        `${occurrence.lockfile}: ${occurrence.path}: the bundle-fix justification could not be established: ${error instanceof Error ? error.message : String(error)}`);
      if (why !== undefined) reasons.push(why);
    }
    proofs.set(versionKey(change.pkg), reasons.length === 0 ? undefined : reasons.join("; "));
  }
  return proofs;
}

interface Occurrence {
  readonly lockfile: string;
  readonly path: string;
  readonly from: string;
  readonly fromIntegrity: string | undefined;
  readonly toIntegrity: string | undefined;
}

/**
 * Each head copy of the young version: where base had a replaced version of it at the same path, either side bundling
 * something, the occurrence to prove; `undefined` for any other copy. Empty when no copy is a carrier replaced in
 * place (no bundle-fix to prove).
 */
function occurrences(change: ChangedVersion, inputs: Pick<BundleFixInputs, "base" | "head">): Array<Occurrence | undefined> {
  const found: Array<Occurrence | undefined> = [];
  for (const lockfile of inputs.head.npm) {
    const before = inputs.base.npm.find((candidate) => candidate.path === lockfile.path)?.packages ?? [];
    for (const copy of lockfile.packages) {
      if (copy.bundled || copy.name !== change.pkg.name || copy.version !== change.pkg.version) continue;
      const old = before.find((candidate) => candidate.path === copy.path && !candidate.bundled && candidate.name === copy.name && change.replaced.includes(candidate.version));
      const bundles = (packages: typeof before) => packages.some((pkg) => pkg.bundled && pkg.path.startsWith(`${copy.path}/node_modules/`));
      found.push(old === undefined || (!bundles(before) && !bundles(lockfile.packages))
        ? undefined
        : { lockfile: lockfile.path, path: copy.path, from: old.version, fromIntegrity: old.integrity, toIntegrity: copy.integrity });
    }
  }
  return found.some((occurrence) => occurrence !== undefined) ? found : [];
}

async function proofProblem(pkg: PackageVersion, occurrence: Occurrence, inputs: BundleFixInputs): Promise<string | undefined> {
  const { reader, registry, config, now } = inputs;
  const at = `${occurrence.lockfile}: ${occurrence.path}`;
  const published = await registryIntegrity(registry, pkg.name, pkg.version);
  if (published === undefined || published !== occurrence.toIntegrity) return `${at}: the locked ${pkg.name}@${pkg.version} isn't the registry's archive`;
  const fromBundle = await reader.read(pkg.name, occurrence.from, occurrence.fromIntegrity);
  const toBundle = await reader.read(pkg.name, pkg.version, occurrence.toIntegrity);
  if (!fromBundle.complete) return `${at}: ${fromBundle.reason}`;
  if (!toBundle.complete) return `${at}: ${toBundle.reason}`;
  const recorded = [
    ...bundleMismatches(lockfileOf(inputs.base, occurrence.lockfile), occurrence.path, fromBundle),
    ...bundleMismatches(lockfileOf(inputs.head, occurrence.lockfile), occurrence.path, toBundle),
  ];
  if (recorded.length > 0) return `${at}: ${recorded.join("; ")}`;
  const versionsOf = (bundle: typeof fromBundle) => bundle.packages.map((entry): PackageVersion => ({ ecosystem: "npm", name: entry.name, version: entry.version }));
  const snapshot = await inputs.scan([
    { ...pkg, version: occurrence.from }, pkg, ...versionsOf(fromBundle), ...versionsOf(toBundle),
  ]);
  const carried = removedTargets(fromBundle, toBundle, snapshot);
  if (carried.length === 0) return `${at}: ${pkg.name}@${pkg.version}'s bundle fixes nothing ${occurrence.from}'s had`;
  // The carrier's own advisories it fixes too: the combined choice secure-it makes, reconstructed from the trees.
  const after = groupsOf(snapshot, pkg);
  const own = targetsOf(snapshot, { ...pkg, version: occurrence.from }).filter((group) => !after.has(group));
  const listed = await inputs.catalog.versions(pkg);
  if (listed === undefined) return `${at}: the registry doesn't list ${pkg.name}'s versions, so the rule can't be checked`;
  const choice = await chooseCarrier({
    carrier: pkg.name,
    from: occurrence.from,
    fromBundle,
    carried,
    own,
    malicious: false,
    versions: candidateVersions(config, pkg, occurrence.from, pkg.version, [...listed, pkg.version]),
    ownPackage: isOwnPackage(config.ownPackages, pkg),
  }, {
    bundles: async (version) => reader.read(pkg.name, version, await registryIntegrity(registry, pkg.name, version)),
    scan: inputs.scan,
    catalog: inputs.catalog,
    config,
    now,
  });
  if (choice.kind !== "chosen") return `${at}: the bundle-fix justification could not be established: ${choice.reason}`;
  if (choice.version !== pkg.version) {
    return `${at}: ${choice.version} ${choice.aged ? `ships a bundle without ${describe(carried)} too and is at least ${config.releaseAgeDays} days old` : `is the lowest version whose bundle drops ${describe(carried)}`} (line ${choice.line})`;
  }
  return undefined;
}

function lockfileOf(inventory: Inventory, path: string) {
  const lockfile = inventory.npm.find((candidate) => candidate.path === path);
  if (lockfile === undefined) throw new Error(`no lockfile ${path} in ${inventory.tree}`);
  return lockfile.packages;
}
