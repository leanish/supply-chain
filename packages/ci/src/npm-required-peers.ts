/** Joint direct-peer requirements forced by a security root, resolved at their actual lockfile locations. */
import semver from "semver";

import { type Config, isOwnPackage } from "./config.ts";
import { isObject } from "./json.ts";
import { directDependencies, type DirectDependency } from "./npm-lock.ts";
import { type NpmRegistry, publishTime } from "./npm-registry.ts";
import { REQUIRED_LIMITS, requiredPath, type RequiredNode, type RequiredTarget } from "./npm-required.ts";
import { compatibleLine } from "./young-fixes.ts";

export const REQUIRED_PEER_LIMITS = { nodes: REQUIRED_LIMITS.nodes, versions: REQUIRED_LIMITS.versions, search: 4096 } as const;
interface PeerLimits { readonly nodes: number; readonly versions: number; readonly search: number }
interface PeerNode {
  readonly direct: DirectDependency;
  readonly doc: Awaited<ReturnType<NpmRegistry["packument"]>>;
  readonly baseline: Record<string, unknown>;
  readonly manifests: ReadonlyMap<string, Record<string, unknown>>;
}

export async function requiredPeerTargets(root: RequiredNode, basePackages: Record<string, unknown>, chosenPackages: Record<string, unknown>, registry: NpmRegistry, config: Config, now: Date, fixed: ReadonlySet<string> = new Set(), limits: PeerLimits = REQUIRED_PEER_LIMITS): Promise<RequiredTarget[]> {
  const rootManifest = (await registry.packument(root.name)).versions[root.version];
  if (!isObject(rootManifest)) throw new Error(`no manifest for required peer root ${root.name}@${root.version}`);
  const packages = { ...chosenPackages, [root.path]: root };
  const nodes = await peerNodes(basePackages, registry, root, fixed);
  const group = await connectedPeers(nodes, root, rootManifest, packages, config, limits);
  if (group.length === 0) return [];
  const viable = viableVersions(group, root, rootManifest, packages, limits);
  const allowed = new Map<string, string[]>();
  const agedVersions = new Map<string, ReadonlySet<string>>();
  for (const node of group) {
    const versions = [...viable.get(node.direct.path)!].sort(semver.compare);
    const own = isOwnPackage(config.ownPackages, { ecosystem: "npm", name: node.direct.name });
    const aged = own ? versions : versions.filter((version) => now.getTime() - publishTime(node.doc, node.direct.name, version).getTime() >= config.releaseAgeDays * 86_400_000);
    agedVersions.set(node.direct.path, new Set(aged));
    // Order complete assignments by package name, then aged before young and lowest first.
    // Preserve an eligible aged locked version to avoid an unnecessary change.
    const preferred = aged.includes(node.direct.version) ? [node.direct.version, ...aged.filter((version) => version !== node.direct.version)] : aged;
    allowed.set(node.direct.path, [...preferred, ...versions.filter((version) => !aged.includes(version))]);
  }
  const selected = chooseVersions(group, root, rootManifest, packages, allowed, agedVersions, limits);
  return group.filter((node) => selected.get(node.direct.path) !== node.direct.version).map((node) => {
    const { direct } = node;
    const version = selected.get(direct.path)!;
    const young = !agedVersions.get(direct.path)!.has(version);
    const own = isOwnPackage(config.ownPackages, { ecosystem: "npm", name: direct.name });
    return { exempt: young, name: direct.name, version, path: direct.path, parent: root, key: direct.declaredAs, range: direct.spec,
      reason: young ? `${root.name}@${root.version} requires a compatible ${direct.name} peer consumer; no version compatible with the selected peer set is at least ${config.releaseAgeDays} days old; ${direct.name}@${version} is the lowest satisfying version`
        : `${root.name}@${root.version} requires a compatible ${direct.name} peer consumer; ${own ? "own-package" : "aged"} ${direct.name}@${version} anchors its required-dependency proof` };
  });
}

async function peerNodes(base: Record<string, unknown>, registry: NpmRegistry, root: RequiredNode, fixed: ReadonlySet<string>): Promise<PeerNode[]> {
  const directs = [...new Map(directDependencies({ packages: base }).map((direct) => [direct.path, direct])).values()];
  const nodes: PeerNode[] = [];
  for (const direct of directs.sort((a, b) => a.path.localeCompare(b.path))) {
    if (direct.path === root.path || fixed.has(direct.path)) continue;
    const doc = await registry.packument(direct.name);
    const baseline = doc.versions[direct.version];
    if (!isObject(baseline)) throw new Error(`no manifest for locked peer consumer ${direct.name}@${direct.version}`);
    peerRanges(baseline);
    nodes.push({ direct, doc, baseline, manifests: new Map() });
  }
  return nodes;
}

async function connectedPeers(nodes: ReadonlyArray<PeerNode>, root: RequiredNode, manifest: Record<string, unknown>, packages: Record<string, unknown>, config: Config, limits: PeerLimits): Promise<PeerNode[]> {
  const active = new Map<string, PeerNode>();
  for (const node of nodes) {
    const outgoing = peerRanges(manifest).find(([key]) => requiredPath(packages, root.path, key, true) === node.direct.path);
    const incoming = peerRanges(node.baseline).some(([key, range]) => requiredPath(packages, node.direct.path, key, true) === root.path && !semver.satisfies(root.version, range));
    if (incoming || outgoing !== undefined && !semver.satisfies(node.direct.version, outgoing[1])) active.set(node.direct.path, node);
  }
  for (;;) {
    if (active.size > limits.nodes) throw new Error("required peer node bound reached");
    for (const [path, node] of active) {
      if (node.manifests.size === 0) active.set(path, { ...node, manifests: candidateManifests(node, config, limits) });
    }
    const size = active.size;
    for (const node of nodes) {
      const manifests = active.get(node.direct.path)?.manifests.values() ?? [node.baseline];
      for (const candidate of manifests) {
        for (const [key] of peerRanges(candidate)) {
          const path = requiredPath(packages, node.direct.path, key, true);
          const peer = nodes.find((other) => other.direct.path === path);
          if (peer === undefined || !active.has(node.direct.path) && !active.has(peer.direct.path)) continue;
          active.set(node.direct.path, active.get(node.direct.path) ?? node);
          active.set(peer.direct.path, active.get(peer.direct.path) ?? peer);
        }
      }
    }
    if (active.size === size) return [...active.values()].sort((a, b) => a.direct.name.localeCompare(b.direct.name) || a.direct.path.localeCompare(b.direct.path));
  }
}

function candidateManifests(node: PeerNode, config: Config, limits: PeerLimits): ReadonlyMap<string, Record<string, unknown>> {
  const pkg = { ecosystem: "npm" as const, name: node.direct.name };
  const line = compatibleLine(config, pkg, node.direct.version);
  const result = new Map<string, Record<string, unknown>>();
  for (const version of Object.keys(node.doc.versions).filter((version) => semver.valid(version) !== null).sort(semver.compare)) {
    if (semver.valid(version) === null || semver.prerelease(version) !== null || compatibleLine(config, pkg, version) !== line) continue;
    const manifest = node.doc.versions[version];
    if (!isObject(manifest)) throw new Error(`${pkg.name}@${version}: unreadable peer candidate manifest`);
    const deprecated = manifest["deprecated"];
    if (deprecated !== undefined && typeof deprecated !== "string") throw new Error(`${pkg.name}@${version}: unreadable deprecation metadata`);
    if (deprecated !== undefined && deprecated !== "") continue;
    peerRanges(manifest);
    result.set(version, manifest);
    if (result.size > limits.versions) throw new Error(`${pkg.name}: required peer version bound reached`);
  }
  return result;
}

function viableVersions(nodes: ReadonlyArray<PeerNode>, root: RequiredNode, manifest: Record<string, unknown>, packages: Record<string, unknown>, limits: PeerLimits): Map<string, Set<string>> {
  const viable = new Map(nodes.map((node) => [node.direct.path, new Set<string>()]));
  const options = new Map(nodes.map((node) => [node.direct.path, [...node.manifests.keys()]]));
  search(nodes, root, manifest, packages, options, limits, (chosen) => {
    for (const [path, version] of chosen) viable.get(path)!.add(version);
    return false;
  });
  if ([...viable.values()].some((versions) => versions.size === 0)) throw new Error("no compatible version accepts the security fix's peer set");
  return viable;
}

function chooseVersions(nodes: ReadonlyArray<PeerNode>, root: RequiredNode, manifest: Record<string, unknown>, packages: Record<string, unknown>, options: ReadonlyMap<string, ReadonlyArray<string>>, aged: ReadonlyMap<string, ReadonlySet<string>>, limits: PeerLimits): Map<string, string> {
  let result: Map<string, string> | undefined;
  search(nodes, root, manifest, packages, options, limits, (chosen) => {
    if (!eligibleAssignment(nodes, root, manifest, packages, options, aged, chosen)) return false;
    result = new Map(chosen);
    return true;
  });
  if (result === undefined) throw new Error("no jointly compatible aged or lowest-required peer set");
  return result;
}

/** Each young choice must be the lowest satisfying version with the rest of this assignment held fixed. */
function eligibleAssignment(nodes: ReadonlyArray<PeerNode>, root: RequiredNode, manifest: Record<string, unknown>, packages: Record<string, unknown>, options: ReadonlyMap<string, ReadonlyArray<string>>, aged: ReadonlyMap<string, ReadonlySet<string>>, chosen: ReadonlyMap<string, string>): boolean {
  return nodes.every((node) => {
    const path = node.direct.path;
    const version = chosen.get(path)!;
    if (aged.get(path)!.has(version)) return true;
    const compatible = options.get(path)!.filter((alternative) =>
      consistent(nodes, root, manifest, packages, new Map(chosen).set(path, alternative)));
    return !compatible.some((alternative) => aged.get(path)!.has(alternative)) &&
      version === [...compatible].sort(semver.compare)[0];
  });
}

function search(nodes: ReadonlyArray<PeerNode>, root: RequiredNode, manifest: Record<string, unknown>, packages: Record<string, unknown>, options: ReadonlyMap<string, ReadonlyArray<string>>, limits: PeerLimits, accept: (chosen: ReadonlyMap<string, string>) => boolean): void {
  let attempts = 0;
  const visit = (chosen: ReadonlyMap<string, string>): boolean => {
    if (chosen.size === nodes.length) return accept(chosen);
    const node = nodes[chosen.size]!;
    for (const version of options.get(node.direct.path) ?? []) {
      if (++attempts > limits.search) throw new Error("required peer search bound reached");
      const next = new Map(chosen).set(node.direct.path, version);
      if (consistent(nodes, root, manifest, packages, next) && visit(next)) return true;
    }
    return false;
  };
  visit(new Map());
}

function consistent(nodes: ReadonlyArray<PeerNode>, root: RequiredNode, manifest: Record<string, unknown>, packages: Record<string, unknown>, chosen: ReadonlyMap<string, string>): boolean {
  const check = (owner: string, entry: Record<string, unknown>, unchanged: boolean): boolean => {
    for (const [key, range] of peerRanges(entry)) {
      const path = requiredPath(packages, owner, key, true);
      const node = nodes.find((other) => other.direct.path === path);
      if (node !== undefined && !chosen.has(node.direct.path)) continue;
      const version = path === root.path ? root.version : path === undefined ? undefined : chosen.get(path) ?? versionAt(packages, path);
      if (unchanged && node !== undefined && version === node.direct.version) continue;
      if (version === undefined && optionalPeer(entry, key)) continue;
      if (version === undefined || !semver.satisfies(version, range)) return false;
    }
    return true;
  };
  if (!check(root.path, manifest, false)) return false;
  return nodes.every((node) => {
    const version = chosen.get(node.direct.path);
    return version === undefined || check(node.direct.path, node.manifests.get(version)!, version === node.direct.version);
  });
}

function peerRanges(manifest: Record<string, unknown>): Array<[string, string]> {
  const peers = manifest["peerDependencies"];
  if (peers === undefined) return [];
  if (!isObject(peers)) throw new Error("unreadable required peer metadata");
  return Object.entries(peers).map(([key, range]) => {
    if (typeof range !== "string" || semver.validRange(range) === null) throw new Error(`unreadable peer range ${key}`);
    return [key, range];
  });
}

function optionalPeer(manifest: Record<string, unknown>, key: string): boolean {
  const meta = manifest["peerDependenciesMeta"];
  return isObject(meta) && isObject(meta[key]) && meta[key]["optional"] === true;
}

function versionAt(packages: Record<string, unknown>, path: string): string | undefined {
  const entry = packages[path];
  return isObject(entry) && typeof entry["version"] === "string" ? entry["version"] : undefined;
}
