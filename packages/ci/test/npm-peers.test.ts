import { describe, expect, it, vi } from "vitest";

import { prepareNpmPeers, type PeerSources } from "../src/npm-peers.ts";
import { versionKey } from "../src/package-version.ts";
import { Snapshot, type Advisory } from "../src/snapshot.ts";

const NOW = new Date("2026-10-07T12:00:00Z");
const OLD = new Date("2026-09-01T00:00:00Z");
const YOUNG = new Date("2026-10-06T00:00:00Z");
const UI = "@vitest/ui";
const COVERAGE = "@vitest/coverage-v8";
const move = { name: "vitest", from: "4.1.7", to: "4.1.11", locations: ["node_modules/vitest"] };
const seed = { ecosystem: "npm" as const, name: "vitest", version: "4.1.11" };

function fixture(options: { outward?: boolean; future?: boolean } = {}) {
  const versions = ["4.1.7", "4.1.8", "4.1.11", ...(options.future ? ["4.1.12"] : [])];
  const manifests = new Map<string, object>();
  for (const version of versions) {
    manifests.set(`vitest@${version}`, options.outward ? { peerDependencies: { [UI]: version, [COVERAGE]: version } } : {});
    for (const name of [UI, COVERAGE]) {
      manifests.set(`${name}@${version}`, { peerDependencies: { vitest: version } });
    }
  }
  const lock = { lockfileVersion: 3, packages: {
    "": { devDependencies: { vitest: "^4.1.7", [UI]: "^4.1.7", [COVERAGE]: "^4.1.7" } },
    "node_modules/vitest": { version: "4.1.7", ...manifests.get("vitest@4.1.7") },
    [`node_modules/${UI}`]: { version: "4.1.7", ...manifests.get(`${UI}@4.1.7`) },
    [`node_modules/${COVERAGE}`]: { version: "4.1.7", ...manifests.get(`${COVERAGE}@4.1.7`) },
  } };
  const sources: PeerSources = {
    versions: vi.fn(async () => versions),
    manifest: vi.fn(async (name, version) => manifests.get(`${name}@${version}`)),
    published: vi.fn(async () => OLD),
    identity: vi.fn(async () => []),
    line: (_name, version) => version.split(".")[0]!,
    isOwn: () => false,
    now: NOW,
    releaseAgeDays: 7,
  };
  return { locks: new Map([["package-lock.json", lock]]), sources, manifests };
}

function snapshot(peers: Awaited<ReturnType<typeof prepareNpmPeers>>, affected: Record<string, Advisory[]> = {}) {
  const entries = [...peers.bases, ...peers.candidates].map((pkg) => [versionKey(pkg), affected[`${pkg.name}@${pkg.version}`] ?? []] as const);
  return new Snapshot(new Map(entries), [], NOW);
}

describe("direct npm peer sets", () => {
  it("plans dtv's UI and coverage directs at the same exact version as the fixed vitest target", async () => {
    const h = fixture({ outward: true, future: true });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.blocked).toEqual([]);
    expect(result.additions.map((addition) => [addition.name, addition.to])).toEqual([[COVERAGE, "4.1.11"], [UI, "4.1.11"]]);
    expect(result.additions[0]?.declarations).toMatchObject([{ lockfile: "package-lock.json", workspace: "", declaredAs: COVERAGE, spec: "^4.1.7" }]);
    expect(result.sets).toEqual([[COVERAGE, UI, "vitest"]]);
    expect(peers.candidates).toContainEqual({ ecosystem: "npm", name: UI, version: "4.1.11" });
  });

  it("also sees incoming peer constraints when the moved package declares no peers itself", async () => {
    const h = fixture();
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).additions.map((addition) => addition.to)).toEqual(["4.1.11", "4.1.11"]);
  });

  it("takes the lowest compatible consistent version, rejecting new advisories, malware, identity breaks and young versions", async () => {
    const h = fixture({ future: true });
    for (const name of [UI, COVERAGE]) {
      for (const version of ["4.1.8", "4.1.11", "4.1.12"]) h.manifests.set(`${name}@${version}`, { peerDependencies: { vitest: "^4.1.11" } });
    }
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const advisory: Advisory = { id: "GHSA-new", ids: ["GHSA-new"], source: "osv", malicious: false, severity: undefined, summary: undefined };
    const affected = { [`${UI}@4.1.8`]: [advisory], [`${COVERAGE}@4.1.8`]: [{ ...advisory, malicious: true }] };
    const judged = snapshot(peers, affected);
    expect((await peers.resolve([move], judged)).additions.map((addition) => addition.to)).toEqual(["4.1.11", "4.1.11"]);
    h.sources.identity = vi.fn(async (name, _from, to) => name !== "vitest" && to === "4.1.11" ? ["publisher changed"] : []);
    expect((await peers.resolve([move], judged)).additions.map((addition) => addition.to)).toEqual(["4.1.12", "4.1.12"]);
    h.sources.published = vi.fn(async (_name, version) => version === "4.1.12" ? YOUNG : OLD);
    expect((await peers.resolve([move], judged)).blocked).toHaveLength(1);
  });

  it("lets only own packages skip the companion age requirement, and does not give young companions the security exemption", async () => {
    const h = fixture();
    h.sources.published = vi.fn(async () => YOUNG);
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).blocked[0]?.reason).toContain("no safe aged compatible direct-peer set");
    h.sources.isOwn = (name) => name.startsWith("@vitest/");
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.blocked).toEqual([]);
    expect(result.additions.every((addition) => !addition.aged)).toBe(true);
  });

  it("blocks the whole connected set when fixed targets disagree, without blocking an unrelated move", async () => {
    const h = fixture();
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const other = { name: "other", from: "1.0.0", to: "1.0.1", locations: ["node_modules/other"] };
    const pinnedUi = { name: UI, from: "4.1.7", to: "4.1.8", locations: [`node_modules/${UI}`] };
    const result = await peers.resolve([move, pinnedUi, other], snapshot(peers));
    expect(result.additions).toEqual([]);
    expect(result.blocked[0]?.moves).toEqual([move, pinnedUi]);
  });

  it("keeps unchanged peers at base and ignores unrelated pre-existing peer problems", async () => {
    const h = fixture();
    for (const version of ["4.1.8", "4.1.11"]) h.manifests.set(`vitest@${version}`, { peerDependencies: { absent: "^1" }, peerDependenciesMeta: { absent: { optional: true } } });
    h.manifests.set(`${UI}@4.1.7`, { peerDependencies: { vitest: "^4" } });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).additions.map((addition) => addition.name)).toEqual([COVERAGE]);
  });

  it("may align a companion downward within its compatible line when that is the only consistent set", async () => {
    const h = fixture({ future: true });
    Object.assign(h.locks.get("package-lock.json")!.packages[`node_modules/${UI}`], { version: "4.1.12" });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).additions.find((addition) => addition.name === UI)).toMatchObject({ from: "4.1.12", to: "4.1.11" });
  });

  it("finds incoming peers omitted from the lockfile and leaves new indirect peers to npm", async () => {
    const h = fixture();
    delete (h.locks.get("package-lock.json")!.packages[`node_modules/${UI}`] as { peerDependencies?: object }).peerDependencies;
    h.manifests.set("vitest@4.1.11", { peerDependencies: { newIndirectPeer: "^1" } });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.blocked).toEqual([]);
    expect(result.additions).toHaveLength(2);
  });

  it("reports unreadable locked peer metadata rather than inferring consistency from an incomplete lockfile", async () => {
    const h = fixture();
    h.manifests.delete(`${UI}@4.1.7`);
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).blocked[0]?.reason).toContain("cannot read locked direct-peer metadata");
  });

  it("closes a chain of direct peers introduced by a companion's candidate manifest", async () => {
    const h = fixture();
    const original = h.sources.versions;
    h.sources.versions = async (name) => name === "adapter" ? ["1.0.0", "1.1.0", "1.2.0"] : original(name);
    h.manifests.set("adapter@1.0.0", {});
    h.manifests.set("adapter@1.1.0", {});
    h.manifests.set("adapter@1.2.0", {});
    h.manifests.set(`${UI}@4.1.11`, { peerDependencies: { vitest: "4.1.11", adapter: "^1.1.0" } });
    const lock = h.locks.get("package-lock.json")!;
    Object.assign(lock.packages[""].devDependencies, { adapter: "^1.0.0" });
    Object.assign(lock.packages, { "node_modules/adapter": { version: "1.0.0" } });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.blocked).toEqual([]);
    expect(result.additions.find((addition) => addition.name === "adapter")?.to).toBe("1.1.0");
  });

  it("keeps root and workspace peer sets separate and carries an alias's declaring key", async () => {
    const h = fixture();
    const lock = h.locks.get("package-lock.json")!;
    Object.assign(lock.packages, {
      client: { devDependencies: { vitest: "^4.1.7", compat: "npm:@vitest/ui@^4.1.7" } },
      "client/node_modules/vitest": { version: "4.1.7" },
      "client/node_modules/compat": { name: UI, version: "4.1.7", peerDependencies: { vitest: "4.1.7" } },
    });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([{ ...move, locations: ["client/node_modules/vitest"] }], snapshot(peers));
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]).toMatchObject({ name: UI, locations: ["client/node_modules/compat"], declarations: [{ workspace: "client", declaredAs: "compat", spec: "npm:@vitest/ui@^4.1.7" }] });
  });
});
