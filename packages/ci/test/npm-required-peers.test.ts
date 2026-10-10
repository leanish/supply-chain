import { describe, expect, it } from "vitest";

import { securityCandidates } from "../src/candidates.ts";
import { runCompare } from "../src/gate.ts";
import { parseConfig } from "../src/config.ts";
import { NpmRegistry } from "../src/npm-registry.ts";
import { requiredPeerTargets, REQUIRED_PEER_LIMITS } from "../src/npm-required-peers.ts";
import { environment, FIXED, json, locked, metadata, NOW, OLD, tree, YOUNG } from "./required-fixture.ts";

const UI = "@vitest/ui";
const COVERAGE = "@vitest/coverage-v8";
function fixture(outward = false) {
  const docs: NonNullable<NonNullable<Parameters<typeof environment>[0]>["docs"]> = {
    vitest: { time: { "4.1.7": OLD, "4.1.11": YOUNG }, versions: {
      "4.1.7": metadata,
      "4.1.11": { ...metadata, ...(outward ? { peerDependencies: { [UI]: "4.1.11", [COVERAGE]: "4.1.11" } } : {}) },
    } },
    ...Object.fromEntries([UI, COVERAGE].map((name) => [name, { time: { "4.1.7": OLD, "4.1.11": YOUNG, "4.1.12": YOUNG }, versions: {
      "4.1.7": { ...metadata, peerDependencies: { vitest: "4.1.7" } },
      "4.1.11": { ...metadata, peerDependencies: { vitest: "4.1.11" } },
      "4.1.12": { ...metadata, peerDependencies: { vitest: "4.1.11" } },
    } }])),
  };
  const files = (version: string) => {
    const manifest = { devDependencies: { vitest: `^${version}`, [UI]: `^${version}`, [COVERAGE]: `^${version}` } };
    return { "package.json": json(manifest), "package-lock.json": json({ lockfileVersion: 3, packages: {
      "": manifest, ...Object.fromEntries(["vitest", UI, COVERAGE].map((name) => [`node_modules/${name}`, locked(name, version)])),
    } }) };
  };
  return { docs, base: files("4.1.7"), head: files("4.1.11"), env: environment({ docs, affected: { "vitest@4.1.7": [FIXED] } }).env };
}

describe("young security peer companions", () => {
  it.each([true, false])("plans and independently verifies the lowest forced direct peer set (outgoing peers: %s)", async (outward) => {
    const h = fixture(outward);
    const choices = await securityCandidates(tree(h.base), h.env);
    const peers = await choices.npmPeers!.resolve([{ name: "vitest", from: "4.1.7", to: "4.1.11", locations: ["node_modules/vitest"] }]);
    expect(peers.blocked).toEqual([]);
    expect(peers.additions.map((move) => [move.name, move.to, move.aged])).toEqual([[COVERAGE, "4.1.11", false], [UI, "4.1.11", false]]);
    const verdict = await runCompare(tree(h.base), tree(h.head, "head"), h.env);
    expect(verdict.failures).toEqual([]);
    expect(verdict.notes.join()).toContain("lowest satisfying version");
  });

  it("plans and gates reciprocal young companions as one consistent peer set", async () => {
    const h = fixture();
    for (const [name, other] of [[UI, COVERAGE], [COVERAGE, UI]]) {
      for (const version of ["4.1.7", "4.1.11", "4.1.12"]) {
        const manifest = h.docs[name!]!.versions[version] as { peerDependencies: Record<string, string> };
        manifest.peerDependencies[other!] = version;
      }
    }
    const env = environment({ docs: h.docs, affected: { "vitest@4.1.7": [FIXED] } }).env;
    const choices = await securityCandidates(tree(h.base), env);
    const peers = await choices.npmPeers!.resolve([{ name: "vitest", from: "4.1.7", to: "4.1.11", locations: ["node_modules/vitest"] }]);
    expect(peers.blocked).toEqual([]);
    expect(peers.additions.map((move) => [move.name, move.to])).toEqual([[COVERAGE, "4.1.11"], [UI, "4.1.11"]]);
    expect((await runCompare(tree(h.base), tree(h.head, "head"), env)).failures).toEqual([]);
  });

  it.each([false, true])("plans and independently gates a complete crossed-version peer assignment (aged alternative: %s)", async (agedAlternative) => {
    const h = fixture();
    for (const [name, other] of [[UI, COVERAGE], [COVERAGE, UI]]) {
      for (const [version, peer] of [["4.1.7", "4.1.7"], ["4.1.11", "4.1.12"], ["4.1.12", "4.1.11"]]) {
        const manifest = h.docs[name!]!.versions[version!] as { peerDependencies: Record<string, string> };
        manifest.peerDependencies[other!] = peer!;
      }
    }
    if (agedAlternative) {
      h.docs[COVERAGE]!.time["4.1.12"] = OLD;
      h.docs[UI]!.time["4.1.11"] = OLD;
    }
    const env = environment({ docs: h.docs, affected: { "vitest@4.1.7": [FIXED] } }).env;
    const choices = await securityCandidates(tree(h.base), env);
    const peers = await choices.npmPeers!.resolve([{ name: "vitest", from: "4.1.7", to: "4.1.11", locations: ["node_modules/vitest"] }]);
    expect(peers.blocked).toEqual([]);
    const coverageVersion = agedAlternative ? "4.1.12" : "4.1.11";
    const uiVersion = agedAlternative ? "4.1.11" : "4.1.12";
    // Sorted package names: coverage selects its aged version, otherwise its lowest; UI follows the complete pair.
    expect(peers.additions.map((move) => [move.name, move.to, move.aged])).toEqual([[COVERAGE, coverageVersion, agedAlternative], [UI, uiVersion, agedAlternative]]);
    const lock = JSON.parse(h.head["package-lock.json"]);
    for (const [name, version] of [[COVERAGE, coverageVersion], [UI, uiVersion]]) {
      lock.packages[`node_modules/${name}`].version = version;
      lock.packages[`node_modules/${name}`].resolved = `https://registry.npmjs.org/${name}/-/${name!.split("/").pop()}-${version}.tgz`;
      lock.packages[""].devDependencies[name!] = `^${version}`;
    }
    const head = { "package-lock.json": json(lock), "package.json": json(lock.packages[""]) };
    const outcome = await runCompare(tree(h.base), tree(head, "head"), env);
    expect(outcome.failures).toEqual([]);
    if (!agedAlternative) expect(outcome.notes.join()).toContain(`${UI}@4.1.12 is the lowest satisfying version`);
    expect((await runCompare(tree(h.base), tree(h.head, "wrong-pair"), env)).failures.length).toBeGreaterThan(0);
  });

  it("leaves an independent workspace's copy outside the root's outgoing peer requirement", async () => {
    const docs = {
      tool: { time: { "1.0.1": YOUNG }, versions: { "1.0.1": { peerDependencies: { lib: "^1" } } } },
      lib: { time: { "1.0.0": OLD, "2.0.0": OLD }, versions: { "1.0.0": {}, "2.0.0": {} } },
    };
    const packages = {
      "": {}, "apps/a": { dependencies: { tool: "^1", lib: "^1" } }, "apps/b": { dependencies: { lib: "^2" } },
      "apps/a/node_modules/tool": { version: "1.0.1" }, "apps/a/node_modules/lib": { version: "1.0.0" }, "apps/b/node_modules/lib": { version: "2.0.0" },
    };
    const registry = new NpmRegistry(environment({ docs }).env.fetch);
    expect(await requiredPeerTargets({ name: "tool", version: "1.0.1", path: "apps/a/node_modules/tool" }, packages, packages, registry, parseConfig({}), NOW)).toEqual([]);
  });

  it("reports joint peer search exhaustion rather than accepting a partial choice", async () => {
    const h = fixture();
    const base = JSON.parse(h.base["package-lock.json"]).packages;
    const registry = new NpmRegistry(h.env.fetch);
    await expect(requiredPeerTargets({ name: "vitest", version: "4.1.11", path: "node_modules/vitest" }, base, base, registry, parseConfig({}), NOW, new Set(), { ...REQUIRED_PEER_LIMITS, search: 1 })).rejects.toThrow("search bound reached");
  });

  it.each([2, 3, 4])("checks the joint search boundary at %s attempted assignments", async (search) => {
    const h = fixture();
    const base = JSON.parse(h.base["package-lock.json"]).packages;
    delete base[""].devDependencies[COVERAGE];
    delete base[`node_modules/${COVERAGE}`];
    const call = requiredPeerTargets({ name: "vitest", version: "4.1.11", path: "node_modules/vitest" }, base, base, new NpmRegistry(h.env.fetch), parseConfig({}), NOW, new Set(), { ...REQUIRED_PEER_LIMITS, search });
    if (search < 3) await expect(call).rejects.toThrow("search bound reached");
    else expect((await call).map((target) => target.version)).toEqual(["4.1.11"]);
  });

  it("does not grant a peer exemption if an aged consistent companion exists", async () => {
    const h = fixture();
    for (const name of [UI, COVERAGE]) h.docs[name]!.time["4.1.12"] = OLD;
    const env = environment({ docs: h.docs }).env;
    const base = JSON.parse(h.base["package-lock.json"]).packages;
    const head = JSON.parse(h.head["package-lock.json"]).packages;
    const required = await requiredPeerTargets({ name: "vitest", version: "4.1.11", path: "node_modules/vitest" }, base, head, new NpmRegistry(env.fetch), parseConfig({}), NOW);
    expect(required.every((target) => !target.exempt)).toBe(true);
    expect(required.map((target) => target.version)).toEqual(["4.1.12", "4.1.12"]);
  });
});
