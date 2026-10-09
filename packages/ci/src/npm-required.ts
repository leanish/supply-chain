/** Registry-only release-age evidence for dependencies forced by a proved npm security fix. */
import semver from "semver";

import { isObject } from "./json.ts";
import { type NpmRegistry, publishTime } from "./npm-registry.ts";
import type { PackageVersion } from "./package-version.ts";

export const REQUIRED_LIMITS = { depth: 8, nodes: 128, versions: 2048 } as const;
const DAY_MS = 86_400_000;

export interface RequiredNode {
  readonly name: string;
  readonly version: string;
  readonly path: string;
}

export interface RequiredTarget extends RequiredNode {
  readonly parent: RequiredNode;
  readonly key: string;
  readonly range: string;
  readonly reason: string;
  /** False for an aged bridge whose exact version is needed to preserve the descendant proof. */
  readonly exempt: boolean;
}

export interface RequiredProof {
  readonly root: RequiredNode;
  readonly targets: ReadonlyArray<RequiredTarget>;
  /** Other verified security roots this root's requirements reach: no targets, but the root depends on their versions. */
  readonly reached: ReadonlyArray<RequiredNode>;
  readonly problems: ReadonlyArray<string>;
}

export interface RequiredInputs {
  readonly registry: NpmRegistry;
  readonly days: number;
  readonly now: Date;
  /** Resolve the installed key alongside peers or below ordinary parents. Absent optional edges are skipped. */
  readonly placement: (parent: RequiredNode, key: string, peer: boolean, optional: boolean) => string | undefined;
  /** Additional applicable ranges, read by the caller from registry parents or repository declarations/overrides. */
  readonly constraints?: (path: string, name: string) => Promise<ReadonlyArray<string>>;
  readonly isOwn?: (name: string) => boolean;
  readonly installed?: (path: string) => string | undefined;
  /** Paths holding another verified security root: its own proof covers it, so a requirement reaching it must accept its version. */
  readonly verifiedRoot?: (path: string) => boolean;
  readonly incoming?: (node: RequiredNode) => Promise<ReadonlyArray<RequiredTarget>>;
  readonly selected?: (target: RequiredTarget) => void;
  readonly limits?: { readonly depth: number; readonly nodes: number; readonly versions: number };
}

/** Gather before the advisory snapshot; the caller must establish that the root really is a rule-picked fix. */
export async function requiredClosure(root: RequiredNode, inputs: RequiredInputs): Promise<RequiredProof> {
  const targets: RequiredTarget[] = [];
  const reached: RequiredNode[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const limits = inputs.limits ?? REQUIRED_LIMITS;
  const visit = async (node: RequiredNode, depth: number): Promise<void> => {
    const id = `${node.path}|${node.name}@${node.version}`;
    if (seen.has(id)) return;
    if (depth > limits.depth || seen.size >= limits.nodes) throw new Error(`required-dependency proof bound reached (depth ${limits.depth}, nodes ${limits.nodes})`);
    seen.add(id);
    const manifest = (await inputs.registry.packument(node.name)).versions[node.version];
    if (!isObject(manifest)) throw new Error(`no registry manifest for ${node.name}@${node.version}`);
    // Select the whole direct-peer set before following cycles between companions.
    const incoming = await inputs.incoming?.(node) ?? [];
    for (const target of incoming) inputs.selected?.(target);
    for (const target of incoming) {
      const before = targets.length;
      if (target.exempt) targets.push(target);
      await visit(target, depth + 1);
      if (!target.exempt && targets.length > before) targets.splice(before, 0, target);
    }
    for (const edge of requirements(manifest)) {
      const path = inputs.placement(node, edge.key, edge.peer, edge.optional);
      if (path === undefined && edge.optional) continue;
      if (path === undefined) throw new Error(`${node.name}@${node.version}: unsupported placement for ${edge.key}`);
      const spec = requirementSpec(edge.key, edge.spec);
      if (inputs.verifiedRoot?.(path) === true) {
        const version = inputs.installed?.(path);
        if (version === undefined || !semver.satisfies(version, spec.range)) throw new Error(`${node.name}@${node.version} requires ${edge.key} ${edge.spec}, but the verified security fix at ${path} is ${spec.name}@${version ?? "missing"}`);
        reached.push({ name: spec.name, version, path });
        continue;
      }
      const ranges = [spec.range, ...await inputs.constraints?.(path, spec.name) ?? []];
      const choice = await lowestRequired(spec.name, ranges, inputs, inputs.installed?.(path));
      const { version, exempt } = choice;
      const child = { name: spec.name, version, path };
      const reason = exempt ? `${node.name}@${node.version} requires ${edge.key} ${edge.spec}; no version satisfying ${ranges.join(" & ")} is at least ${inputs.days} days old; ${spec.name}@${version} is the lowest satisfying version`
        : `${node.name}@${node.version} requires ${edge.key} ${edge.spec}; ${inputs.isOwn?.(spec.name) ? "own-package" : "aged"} ${spec.name}@${version} anchors its required-dependency proof`;
      const target = { ...child, parent: node, key: edge.key, range: edge.spec, reason, exempt };
      const before = targets.length;
      inputs.selected?.(target);
      if (exempt) targets.push(target);
      await visit(child, depth + 1);
      if (!exempt && targets.length > before) targets.splice(before, 0, target);
    }

  };
  try {
    await visit(root, 0);
  } catch (error) {
    problems.push(`${root.name}@${root.version}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { root, targets, reached, problems };
}

/** An alias keeps its installed key but reads versions/dates of the real package. Tags and non-registry specs cannot prove absence. */
export function requirementSpec(key: string, spec: string): { name: string; range: string } {
  const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(spec);
  const name = alias?.[1] ?? key;
  const range = alias?.[2] ?? spec;
  if (semver.validRange(range) === null) throw new Error(`unreadable required range ${key}: ${spec}`);
  return { name, range };
}

async function lowestRequired(name: string, ranges: ReadonlyArray<string>, inputs: RequiredInputs, installed: string | undefined): Promise<{ version: string; exempt: boolean }> {
  if (ranges.some((range) => semver.validRange(range) === null)) throw new Error(`${name}: unreadable applicable requirement`);
  const doc = await inputs.registry.packument(name);
  const candidates = Object.entries(doc.versions).filter(([version, manifest]) => {
    if (semver.valid(version) === null || semver.prerelease(version) !== null || !ranges.every((range) => semver.satisfies(version, range))) return false;
    if (!isObject(manifest)) throw new Error(`${name}@${version}: unreadable candidate manifest`);
    const deprecated = manifest["deprecated"];
    if (deprecated !== undefined && typeof deprecated !== "string") throw new Error(`${name}@${version}: unreadable deprecation metadata`);
    return deprecated === undefined || deprecated === "";
  }).map(([version]) => version).sort(semver.compare);
  if (candidates.length === 0) throw new Error(`${name}: no stable non-deprecated version satisfies ${ranges.join(" & ")}`);
  if (candidates.length > (inputs.limits ?? REQUIRED_LIMITS).versions) throw new Error(`${name}: required-dependency version bound reached`);
  if (inputs.isOwn?.(name)) return { version: installed !== undefined && candidates.includes(installed) ? installed : candidates[0]!, exempt: false };
  // Check every date: an unknown one cannot establish that no aged satisfying version exists.
  const dates = candidates.map((version) => publishTime(doc, name, version));
  const aged = candidates.filter((_, index) => inputs.now.getTime() - dates[index]!.getTime() >= inputs.days * DAY_MS);
  if (aged.length > 0) return { version: installed !== undefined && aged.includes(installed) ? installed : aged[0]!, exempt: false };
  return { version: candidates[0]!, exempt: true };
}

export interface Requirement { readonly key: string; readonly spec: string; readonly peer: boolean; readonly optional: boolean }
/** npm's effective registry edges: optional declarations replace ordinary ones with the same key. */
export function requirements(manifest: Record<string, unknown>): Requirement[] {
  const result: Requirement[] = [];
  const meta = manifest["peerDependenciesMeta"];
  const regular = new Map<string, Requirement>();
  for (const field of ["peerDependencies", "dependencies", "optionalDependencies"]) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    if (!isObject(entries) || Object.values(entries).some((value) => typeof value !== "string")) throw new Error(`unreadable ${field}`);
    for (const [key, spec] of Object.entries(entries)) {
      const peerMeta = isObject(meta) ? meta[key] : undefined;
      const edge = { key, spec: spec as string, peer: field === "peerDependencies", optional: field === "optionalDependencies" || field === "peerDependencies" && isObject(peerMeta) && peerMeta["optional"] === true };
      if (edge.peer) result.push(edge);
      else regular.set(key, edge); // optionalDependencies override the corresponding ordinary dependency.
    }
  }
  return [...result, ...regular.values()];
}

/** The required versions to add to the same advisory snapshot, never separate advisory reads. */
export function requiredVersions(proofs: ReadonlyArray<RequiredProof>): PackageVersion[] {
  return proofs.flatMap((proof) => proof.targets.map((target) => ({ ecosystem: "npm" as const, name: target.name, version: target.version })));
}

/** Resolve a lockfile copy; peers live beside their parent, ordinary dependencies may live below it. */
export function requiredPath(packages: Readonly<Record<string, unknown>>, parent: string, key: string, peer: boolean): string | undefined {
  let dir = peer ? parent.slice(0, parent.lastIndexOf("node_modules/")).replace(/\/$/, "") : parent;
  for (;;) {
    const path = dir === "" ? `node_modules/${key}` : `${dir}/node_modules/${key}`;
    if (packages[path] !== undefined) return path;
    if (dir === "") return undefined;
    const cut = dir.lastIndexOf("/node_modules/");
    dir = cut !== -1 ? dir.slice(0, cut) : dir.includes("/") && !dir.startsWith("node_modules/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
}
