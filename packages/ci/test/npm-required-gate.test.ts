import { describe, expect, it } from "vitest";

import { runCompare } from "../src/gate.ts";
import { environment, files, json, metadata, OLD, postcss, tree, vite, locked, YOUNG, securityBatch } from "./required-fixture.ts";

describe("independently gated security requirements", () => {
  it("accepts synthetic Vite 8.3.3 and its lowest required young PostCSS on one snapshot", async () => {
    const h = environment();
    const outcome = await runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), h.env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes.join()).toContain("postcss@8.5.29 is the lowest satisfying version");
    expect(h.scans).toHaveLength(1);
  });

  it("reconstructs two independently proved security roots jointly on one snapshot", async () => {
    const batch = securityBatch();
    const h = environment(batch);
    const outcome = await runCompare(tree(batch.base), tree(batch.head, "head"), h.env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes.join()).toContain("postcss@8.5.29 is the lowest satisfying version");
    expect(h.scans).toHaveLength(1);
  });

  it("does not trust an ordinary second root to narrow the shared requirement", async () => {
    const batch = securityBatch();
    const root = { ...batch.docs.vite, versions: {
      ...batch.docs.vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "^8.5.28" } },
    } };
    const env = environment({ docs: { ...batch.docs, vite: root }, affected: { "vite@8.3.2": ["GHSA-fixed"] } }).env;
    const outcome = await runCompare(tree(batch.base), tree(batch.head, "head"), env);
    expect(outcome.failures.join()).toContain("postcss");
    expect(outcome.notes.join()).not.toContain("lowest satisfying version");
  });

  it("lets an installed optional dependency replace its same-key ordinary declaration", async () => {
    const root = { ...vite, versions: {
      ...vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "8.5.28" }, optionalDependencies: { postcss: "8.5.29" } },
    } };
    const outcome = await runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), environment({ docs: { vite: root } }).env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes.join()).toContain("postcss@8.5.29 is the lowest satisfying version");
  });

  it("supports a newly introduced required package without borrowing an old child's advisory", async () => {
    const outcome = await runCompare(tree(files("8.3.2", undefined)), tree(files("8.3.3", "8.5.29"), "head"), environment().env);
    expect(outcome.failures).toEqual([]);
  });

  it.each(["ordinary", "higher", "aged-alternative"])("refuses %s even with a forged plan annotation", async (scenario) => {
    const docs: NonNullable<Parameters<typeof environment>[0]>["docs"] = scenario === "aged-alternative" ? { postcss: { ...postcss, time: { ...postcss.time, "8.5.29": OLD } } }
      : {};
    const head = files("8.3.3", scenario === "higher" || scenario === "aged-alternative" ? "8.5.30" : "8.5.29");
    head["PLAN.md"] = "postcss@8.5.30 has a release-age exemption";
    const h = environment({ docs, ...(scenario === "ordinary" ? { affected: {} } : {}) });
    const outcome = await runCompare(tree(files()), tree(head, "head"), h.env);
    expect(outcome.failures.join()).toContain("postcss");
    expect(outcome.failures.length).toBeGreaterThan(0);
  });

  it("reads dependency ranges from the registry, not the PR's lock metadata or exact declaration", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "^8.5.28" } } } };
    const head = files("8.3.3", "8.5.29");
    const lock = JSON.parse(head["package-lock.json"]!);
    lock.packages["node_modules/vite"].dependencies.postcss = "8.5.29";
    lock.packages[""].devDependencies.postcss = "8.5.29";
    head["package-lock.json"] = json(lock);
    head["package.json"] = json(lock.packages[""]);
    const outcome = await runCompare(tree(files()), tree(head, "head"), environment({ docs: { vite: root } }).env);
    expect(outcome.failures.join()).toContain("postcss@8.5.29");
  });

  it("checks an aged rule-picked security root too", async () => {
    const doc = { ...vite, time: { ...vite.time, "8.3.3": OLD } };
    const outcome = await runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), environment({ docs: { vite: doc } }).env);
    expect(outcome.failures).toEqual([]);
  });

  it("fails closed on unknown dates", async () => {
    const docs = { postcss: { ...postcss, time: { ...postcss.time, "8.5.30": undefined } } };
    await expect(runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), environment({ docs }).env)).rejects.toThrow("publish time");
  });
  it("follows an aged bridge to a forced young child", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { bridge: "^1" } } } };
    const bridge = { time: { "1.0.0": OLD }, versions: { "1.0.0": { ...metadata, dependencies: { postcss: "^8.5.29" } } } };
    const head = files("8.3.3", "8.5.29");
    const lock = JSON.parse(head["package-lock.json"]!);
    lock.packages["node_modules/bridge"] = locked("bridge", "1.0.0");
    head["package-lock.json"] = json(lock);
    const outcome = await runCompare(tree(files()), tree(head, "head"), environment({ docs: { vite: root, bridge } }).env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes.join()).toContain("aged bridge@1.0.0 anchors");
  });

  it("does not exempt a young child caused by an optional ordinary upgrade of an aged bridge", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { bridge: "^1" } } } };
    const bridge = { time: { "1.0.0": OLD, "1.1.0": OLD }, versions: {
      "1.0.0": { ...metadata, dependencies: { postcss: "^8.5.28" } },
      "1.1.0": { ...metadata, dependencies: { postcss: "^8.5.29" } },
    } };
    const original = files();
    const head = files("8.3.3", "8.5.29");
    for (const [data, version] of [[original, "1.0.0"], [head, "1.1.0"]] as const) {
      const lock = JSON.parse(data["package-lock.json"]!);
      lock.packages["node_modules/bridge"] = locked("bridge", version);
      data["package-lock.json"] = json(lock);
    }
    const outcome = await runCompare(tree(original), tree(head, "head"), environment({ docs: { vite: root, bridge } }).env);
    expect(outcome.failures.join()).toContain("postcss@8.5.29");
  });

  it("reports a recursion bound as a blocker rather than granting a partial proof", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { child0: "1.0.0" } } } };
    const docs: NonNullable<NonNullable<Parameters<typeof environment>[0]>["docs"]> = { vite: root };
    const head = files("8.3.3", undefined);
    const lock = JSON.parse(head["package-lock.json"]!);
    for (let index = 0; index < 10; index++) {
      const name = `child${index}`;
      docs[name] = { time: { "1.0.0": YOUNG }, versions: { "1.0.0": { ...metadata, ...(index < 9 ? { dependencies: { [`child${index + 1}`]: "1.0.0" } } : {}) } } };
      lock.packages[`node_modules/${name}`] = locked(name, "1.0.0");
    }
    head["package-lock.json"] = json(lock);
    const outcome = await runCompare(tree(files()), tree(head, "head"), environment({ docs }).env);
    expect(outcome.failures.join()).toContain("required-dependency proof bound reached");
    expect(outcome.failures.join()).toContain("child0@1.0.0");
  });

  it("allows an own-package security root while still proving the third-party requirement", async () => {
    const config = json({ ownPackages: { npm: { scopes: ["@acme"] } } });
    const original = files();
    const head = files("8.3.3", "8.5.29");
    for (const data of [original, head]) {
      const lock = JSON.parse(data["package-lock.json"]!);
      const root = lock.packages["node_modules/vite"];
      delete lock.packages["node_modules/vite"];
      lock.packages["node_modules/@acme/tool"] = { ...root, name: "@acme/tool", resolved: `https://registry.npmjs.org/@acme/tool/-/tool-${root.version}.tgz` };
      lock.packages[""].devDependencies = { "@acme/tool": `^${root.version}` };
      data["package.json"] = json(lock.packages[""]);
      data["package-lock.json"] = json(lock);
      data[".github/supply-chain.json"] = config;
    }
    const env = environment({ docs: { "@acme/tool": vite }, affected: { "@acme/tool@8.3.2": ["GHSA-fixed"] } }).env;
    expect((await runCompare(tree(original), tree(head, "head"), env)).failures).toEqual([]);
  });

});
