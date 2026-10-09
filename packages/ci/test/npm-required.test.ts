import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.ts";
import { NpmRegistry } from "../src/npm-registry.ts";
import { requiredClosure, requiredPath, REQUIRED_LIMITS } from "../src/npm-required.ts";
import { verifiedRequiredProofs } from "../src/npm-required-gate.ts";
import { releaseAgeProblems } from "../src/release-age.ts";
import { NpmCatalog } from "../src/catalogs.ts";
import { parseExceptions } from "../src/exceptions.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";
import { versionKey } from "../src/package-version.ts";
import { gatherCandidates } from "../src/young-fixes.ts";
import { fakeFetch } from "./fake-fetch.ts";

const NOW = new Date("2026-10-09T05:05:00Z");
const old = "2026-09-01T00:00:00Z";
const young = "2026-10-06T00:00:00Z";
const root = { name: "vite", version: "8.3.3", path: "node_modules/vite" };
const baseDoc = { time: { "8.3.2": old, "8.3.3": young }, versions: { "8.3.2": {}, "8.3.3": { dependencies: { postcss: "^8.5.29" } } } };
const postcss = { time: { "8.5.28": old, "8.5.29": young, "8.5.30": young }, versions: { "8.5.28": {}, "8.5.29": {}, "8.5.30": {} } };
function registry(docs: Record<string, unknown> = {}) {
  return new NpmRegistry(fakeFetch(Object.fromEntries(Object.entries({ vite: baseDoc, postcss, ...docs }).map(([name, body]) => [`https://registry.npmjs.org/${encodeURIComponent(name)}`, { body }]))));
}
const inputs = (reg = registry()) => ({ registry: reg, days: 7, now: NOW, placement: (_parent: unknown, key: string) => `node_modules/${key}` });
const config = parseConfig({});
const advisory: Advisory = { id: "GHSA-fixed", ids: ["GHSA-fixed"], malicious: false, source: "osv", summary: undefined, severity: undefined };

describe("npm security-required release age", () => {
  it("2026-10-09 Vite/PostCSS: pins only the lowest satisfying young version when no aged version satisfies", async () => {
    const proof = await requiredClosure(root, inputs());
    expect(proof.problems).toEqual([]);
    expect(proof.targets).toMatchObject([{ name: "postcss", version: "8.5.29", parent: root, range: "^8.5.29" }]);
    expect(proof.targets[0]?.reason).toContain("lowest satisfying version");
  });

  it("keeps another verified security root where the requirement reaches it, if its version satisfies", async () => {
    const at = (version: string) => ({ ...inputs(), verifiedRoot: (path: string) => path === "node_modules/postcss", installed: () => version });
    const kept = await requiredClosure(root, at("8.5.30"));
    expect(kept).toMatchObject({ targets: [], problems: [] });
    const refused = await requiredClosure(root, at("8.5.28"));
    expect(refused.targets).toEqual([]);
    expect(refused.problems.join()).toContain("requires postcss ^8.5.29, but the verified security fix at node_modules/postcss is postcss@8.5.28");
  });

  it("does not exempt the real Vite 8.3.3 requirement when an aged 8.5.28 satisfies ^8.5.28", async () => {
    const proof = await requiredClosure(root, inputs(registry({ vite: { ...baseDoc, versions: { ...baseDoc.versions, "8.3.3": { dependencies: { postcss: "^8.5.28" } } } } })));
    expect(proof.targets).toEqual([]);
    expect(proof.problems).toEqual([]);
  });

  it("blocks incomplete dates rather than treating them as young", async () => {
    const proof = await requiredClosure(root, inputs(registry({ postcss: { ...postcss, time: { "8.5.29": young } } })));
    expect(proof.problems.join()).toContain("publish time");
  });

  it("blocks unreadable candidate metadata instead of silently excluding a possible aged satisfier", async () => {
    const proof = await requiredClosure(root, inputs(registry({ postcss: { ...postcss, versions: { ...postcss.versions, "8.5.29": null } } })));
    expect(proof.problems.join()).toContain("unreadable candidate manifest");
  });

  it("does not require an own dependency's publish time to honor its existing age exemption", async () => {
    const reg = registry({ vite: { ...baseDoc, versions: { ...baseDoc.versions, "8.3.3": { dependencies: { "@own/lib": "^1" } } } },
      "@own/lib": { time: {}, versions: { "1.0.0": {} } } });
    const proof = await requiredClosure(root, { ...inputs(reg), isOwn: (name) => name.startsWith("@own/") });
    expect(proof.problems).toEqual([]);
    expect(proof.targets).toEqual([]);
  });

  it("skips deprecated and prerelease versions", async () => {
    const proof = await requiredClosure(root, inputs(registry({ postcss: { ...postcss, versions: { ...postcss.versions, "8.5.29": { deprecated: "bad publish" }, "8.5.30-beta.1": {} } } })));
    expect(proof.targets[0]?.version).toBe("8.5.30");
  });

  it("closes aliases recursively and terminates a cycle connected to the root", async () => {
    const docs = { vite: { ...baseDoc, versions: { ...baseDoc.versions, "8.3.3": { dependencies: { style: "npm:postcss@^8.5.29" } } } },
      postcss: { ...postcss, versions: { ...postcss.versions, "8.5.29": { dependencies: { vite: "8.3.3" } } } } };
    const proof = await requiredClosure(root, inputs(registry(docs)));
    expect(proof.problems).toEqual([]);
    expect(proof.targets.map((target) => target.name)).toEqual(["postcss", "vite"]);
    expect(proof.targets[0]?.key).toBe("style");
  });

  it.each(["depth", "nodes", "versions"] as const)("explicitly blocks the %s bound", async (bound) => {
    const proof = await requiredClosure(root, { ...inputs(), limits: { depth: 8, nodes: 128, versions: 2048, [bound]: 0 } });
    expect(proof.problems.join()).toContain("bound");
  });

  it.each([7, 8, 9])("checks the exact depth boundary at %s edges", async (depth) => {
    const docs: Record<string, unknown> = {};
    for (let index = 0; index < depth; index++) {
      docs[`child${index}`] = { time: { "1.0.0": young }, versions: { "1.0.0": index + 1 < depth ? { dependencies: { [`child${index + 1}`]: "1.0.0" } } : {} } };
    }
    docs.vite = { ...baseDoc, versions: { ...baseDoc.versions, "8.3.3": { dependencies: { child0: "1.0.0" } } } };
    const proof = await requiredClosure(root, inputs(registry(docs)));
    expect(proof.problems.length).toBe(depth > REQUIRED_LIMITS.depth ? 1 : 0);
    if (depth > REQUIRED_LIMITS.depth) expect(proof.problems.join()).toContain("bound reached");
    else expect(proof.targets).toHaveLength(depth);
  });

  it.each([127, 128, 129])("checks the exact visited-node boundary at %s nodes, including the root", async (count) => {
    const docs: Record<string, unknown> = {};
    const dependencies: Record<string, string> = {};
    for (let index = 1; index < count; index++) {
      dependencies[`child${index}`] = "1.0.0";
      docs[`child${index}`] = { time: { "1.0.0": young }, versions: { "1.0.0": {} } };
    }
    docs.vite = { ...baseDoc, versions: { ...baseDoc.versions, "8.3.3": { dependencies } } };
    const proof = await requiredClosure(root, inputs(registry(docs)));
    expect(proof.problems.length).toBe(count > REQUIRED_LIMITS.nodes ? 1 : 0);
    if (count > REQUIRED_LIMITS.nodes) expect(proof.problems.join()).toContain("bound reached");
    else expect(proof.targets).toHaveLength(count - 1);
  });

  it.each([2047, 2048, 2049])("checks the exact version boundary at %s satisfying candidates", async (count) => {
    const versions = Object.fromEntries(Array.from({ length: count }, (_, index) => [`8.5.${29 + index}`, {}]));
    const time = Object.fromEntries(Object.keys(versions).map((version) => [version, young]));
    const proof = await requiredClosure(root, inputs(registry({ postcss: { versions, time } })));
    expect(proof.problems.length).toBe(count > REQUIRED_LIMITS.versions ? 1 : 0);
    if (count > REQUIRED_LIMITS.versions) expect(proof.problems.join()).toContain("version bound reached");
    else expect(proof.targets[0]?.version).toBe("8.5.29");
  });

  it("respects additional applicable constraints without permitting a higher young choice", async () => {
    const proof = await requiredClosure(root, { ...inputs(), constraints: async () => ["<8.5.30"] });
    expect(proof.targets[0]?.version).toBe("8.5.29");
  });

  it("requires a real security root and rejects ordinary bumps and higher induced targets", async () => {
    const reg = registry();
    const cat = new NpmCatalog(reg);
    const catalogs = { npm: cat, Maven: cat, "GitHub Actions": cat };
    const change = { pkg: { ecosystem: "npm" as const, name: "vite", version: "8.3.3" }, replaced: ["8.3.2"], published: new Date(young) };
    const candidates = await gatherCandidates([change], catalogs, config);
    const proof = await requiredClosure(root, inputs(reg));
    const snapshot = (security: boolean) => new Snapshot(new Map([
      ["npm|vite|8.3.2", security ? [advisory] : []], ["npm|vite|8.3.3", []],
      ["npm|postcss|8.5.29", []], ["npm|postcss|8.5.30", []],
    ]), [], NOW);
    const good = await verifiedRequiredProofs([proof], [change], candidates, snapshot(true), cat, config, NOW);
    expect([...good.versions]).toEqual(["npm|postcss|8.5.29"]);
    const ordinary = await verifiedRequiredProofs([proof], [change], candidates, snapshot(false), cat, config, NOW);
    expect(ordinary.versions.size).toBe(0);
    const context = { snapshot: snapshot(true), catalogs, config, now: NOW, exceptions: parseExceptions({}), candidates: candidates.byChange, required: good.versions };
    const child = (version: string) => ({ pkg: { ecosystem: "npm" as const, name: "postcss", version }, published: new Date(young), replaced: [] });
    expect(await releaseAgeProblems([change, child("8.5.29")], context)).toEqual([]);
    expect(await releaseAgeProblems([child("8.5.30")], context)).toHaveLength(1);
    expect(await releaseAgeProblems([child("8.5.29")], { ...context, required: ordinary.versions })).toHaveLength(1);
    const otherEcosystems = (["Maven", "GitHub Actions"] as const).map((ecosystem) => ({
      ...child("8.5.29"), pkg: { ecosystem, name: "postcss", version: "8.5.29" },
    }));
    expect(await releaseAgeProblems(otherEcosystems, context)).toHaveLength(2);
    expect(versionKey(change.pkg)).toBe("npm|vite|8.3.3");
  });

  it("resolves peers alongside parents and ordinary nested/aliased copies separately", () => {
    const packages = { "node_modules/p": {}, "node_modules/x": {}, "node_modules/p/node_modules/x": {} };
    expect(requiredPath(packages, "node_modules/p", "x", true)).toBe("node_modules/x");
    expect(requiredPath(packages, "node_modules/p", "x", false)).toBe("node_modules/p/node_modules/x");
  });
});
