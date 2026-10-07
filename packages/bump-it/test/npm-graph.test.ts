import { describe, expect, it } from "vitest";
import { NpmGraph, rangeOf, rewriteSpec } from "../src/npm-graph.ts";
import { isExactOverride, repositoryOverrides, splitKey } from "../src/npm-overrides.ts";
import { pinnedManifests } from "../src/npm-pins.ts";

const lock = { packages: { "": { name: "root", dependencies: { parent: "^1", compat: "npm:lib@^1" } }, "node_modules/parent": { version: "1.0.0", dependencies: { lib: "^1" } }, "node_modules/parent/node_modules/lib": { version: "1.8.0" }, "node_modules/compat": { name: "lib", version: "1.9.0" } } };

describe("npm specs", () => {
  it.each([["^1.2.0", "^2.3.4"], ["~1.2", "~2.3.4"], ["1", "2.3.4"], ["=1.0.0", "=2.3.4"], [">=1.0.0", ">=2.3.4"], ["npm:@scope/lib@^1.0.0", "npm:@scope/lib@^2.3.4"], ["*", "*"], [">=1 <3", ">=1 <3"]])("rewrites %s keeping its style", (spec, expected) => expect(rewriteSpec(spec, "2.3.4")).toBe(expected));
  it.each(["git+https://example.com/x", "file:../x", "latest", ">=1 <2", "npm:lib"]) ("refuses to invent a rewrite for %s", (spec) => expect(rewriteSpec(spec, "2.3.4")).toBeUndefined());
  it.each([["npm:lib@^1", "^1"], ["npm:@scope/lib@~2", "~2"], ["npm:lib", "*"], ["^1 || ^2", "^1 || ^2"], ["latest", undefined], ["https://a", undefined]])("extracts range %s", (spec, expected) => expect(rangeOf(spec!)).toBe(expected));
});
describe("lockfile graph", () => {
  it("resolves nested copies, aliases, workspaces and peers; links aren't registry copies", () => {
    const graph = new NpmGraph({ packages: { ...lock.packages, ws: { name: "ws", devDependencies: { parent: "^1" } }, "node_modules/ws": { link: true }, "node_modules/parent/node_modules/bundled": { version: "1", inBundle: true } } });
    expect(graph.edgesTo("node_modules/parent/node_modules/lib")).toMatchObject([{ from: "node_modules/parent", spec: "^1", declared: false }]);
    expect(graph.declaredEdges().find((edge) => edge.from === "ws")?.to).toBe("node_modules/parent");
    expect(graph.copies().find((copy) => copy.installedAs === "compat")?.name).toBe("lib");
    expect(graph.copies().some((copy) => copy.name === "ws")).toBe(false);
    expect(graph.copies().find((copy) => copy.name === "bundled")?.bundled).toBe(true);
  });
  it("refuses a lockfile without a packages map", () => expect(() => new NpmGraph({})).toThrow("packages"));
});
describe("repository overrides", () => {
  it.each([
    ["1.4.0", true],
    ["^1.4.0", false],
    ["$lib", false],
    [undefined, false],
  ] as const)("detects an exact resolved pin in %s", (spec, expected) => {
    expect(isExactOverride(spec)).toBe(expected);
  });
  it("detects $lib as exact only when its root declaration is exact", () => {
    const exact = repositoryOverrides({ dependencies: { lib: "1.4.0" }, overrides: { lib: "$lib" } });
    const ranged = repositoryOverrides({ dependencies: { lib: "^1.4.0" }, overrides: { lib: "$lib" } });
    expect(isExactOverride(exact.rangeFor("lib"))).toBe(true);
    expect(isExactOverride(ranged.rangeFor("lib"))).toBe(false);
  });
  it("recognises plain ranges, root references and scoped names, conservatively marking complex rules", () => {
    const rules = repositoryOverrides({ dependencies: { lib: "^1" }, overrides: { lib: "$lib", "@org/x": "1.2.3", "child@^1": "1.2.0", parent: { nested: "2" }, invalid: "latest" } });
    expect(rules.rangeFor("lib")).toBe("^1");
    expect(rules.rangeFor("@org/x")).toBe("1.2.3");
    expect(["child", "nested", "invalid"].every(rules.isComplex)).toBe(true);
    expect(rules.topLevelKeys.has("child@^1")).toBe(true);
    expect(rules.isComplex("parent")).toBe(false);
    expect(splitKey("@org/lib@^2")).toEqual({ name: "@org/lib", spec: "^2" });
  });
  it("doesn't confuse an absent override with a complex one", () => {
    expect(repositoryOverrides({}).rangeFor("lib")).toBeUndefined();
    expect(repositoryOverrides({}).isComplex("lib")).toBe(false);
  });
});
describe("temporary npm pins", () => {
  it("pins a direct alias exactly, without mutating the planned manifest", () => {
    const graph = new NpmGraph(lock);
    const root = { dependencies: { parent: "^1", compat: "npm:lib@^1" } };
    const manifests = new Map([["", root]]);
    const pinned = pinnedManifests(graph, [{ copy: graph.copies().find((copy) => copy.installedAs === "compat")!, target: "1.5.0" }], manifests, repositoryOverrides(root));
    expect(pinned.get("")).toEqual({ dependencies: { parent: "^1", compat: "npm:lib@1.5.0" } });
    expect(root.dependencies.compat).toBe("npm:lib@^1");
  });
  it("uses exact version selectors for transitives and keeps plain overrides temporary", () => {
    const graph = new NpmGraph(lock);
    const copy = graph.copies().find((copy) => copy.installedAs === "lib")!;
    const root = { dependencies: { parent: "^1", compat: "npm:lib@^1" } };
    expect(pinnedManifests(graph, [{ copy, target: "1.5.0" }], new Map([["", root]]), repositoryOverrides(root)).get("")).toMatchObject({ overrides: { "lib@1.8.0": "1.5.0" } });
    const overridden = { ...root, overrides: { lib: "^1" } };
    expect(pinnedManifests(graph, [{ copy, target: "1.5.0" }], new Map([["", overridden]]), repositoryOverrides(overridden)).get("")).toMatchObject({ overrides: { lib: "1.5.0" } });
    expect(overridden.overrides.lib).toBe("^1");
  });
  it("scopes a transitive pin when a root declaration would cause EOVERRIDE", () => {
    const graph = new NpmGraph({ packages: { ...lock.packages, "": { dependencies: { lib: "^1", parent: "^1" } }, "node_modules/lib": { version: "1.0.0" } } });
    const root = { dependencies: { lib: "^1", parent: "^1" } };
    const pinned = pinnedManifests(graph, [{ copy: graph.copies().find((copy) => copy.path.includes("parent/node_modules"))!, target: "1.5.0" }], new Map([["", root]]), repositoryOverrides(root));
    expect(pinned.get("")).toMatchObject({ overrides: { parent: { "lib@1.8.0": "1.5.0" } } });
  });
  it("sets workspace declarations in their own manifests", () => {
    const graph = new NpmGraph({ packages: { "": {}, ws: { dependencies: { lib: "^1" } }, "node_modules/lib": { version: "1.2.0" } } });
    const manifests = new Map([["", {}], ["ws", { dependencies: { lib: "^1" } }]]);
    expect(pinnedManifests(graph, [{ copy: graph.copies()[0]!, target: "1.3.0" }], manifests, repositoryOverrides({})).get("ws")).toMatchObject({ dependencies: { lib: "1.3.0" } });
  });
});
