import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveExact } from "../src/npm-exact.ts";
import { NpmGraph } from "../src/npm-graph.ts";
import { repositoryOverrides } from "../src/npm-overrides.ts";
import { pinnedManifests } from "../src/npm-pins.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("temporary exact npm declarations", () => {
  it.each(["", "ws"])("anchors a peer at root/workspace '%s' instead of an ignored override", (owner) => {
    const path = `${owner === "" ? "" : `${owner}/`}node_modules/vite`;
    const dependent = `${owner === "" ? "" : `${owner}/`}node_modules/parent`;
    const graph = new NpmGraph({ packages: { "": {}, [owner]: {}, [dependent]: { version: "1.0.0", peerDependencies: { vite: "^8" } }, [path]: { version: "8.3.2" } } });
    const manifests = new Map([["", {}], ["ws", {}]]);
    const result = pinnedManifests(graph, [{ copy: graph.copies().find((copy) => copy.path === path)!, target: "8.3.3" }], manifests, repositoryOverrides({}));
    expect(result.get(owner)).toEqual({ devDependencies: { vite: "8.3.3" } });
    expect(result.get(owner)?.["overrides"]).toBeUndefined();
    expect(manifests.get(owner)).toEqual({});
  });

  it("anchors mixed peer/ordinary edges and preserves an npm alias", () => {
    const graph = new NpmGraph({ packages: { "": {}, "node_modules/a": { version: "1.0.0", peerDependencies: { compat: "npm:lib@^1" } }, "node_modules/b": { version: "1.0.0", dependencies: { compat: "npm:lib@^1" } }, "node_modules/compat": { name: "lib", version: "1.0.0" } } });
    const result = pinnedManifests(graph, [{ copy: graph.copies().find((copy) => copy.name === "lib")!, target: "1.1.0" }], new Map([["", {}]]), repositoryOverrides({}));
    expect(result.get("")).toEqual({ devDependencies: { compat: "npm:lib@1.1.0" } });
  });

  it("does not trust peer:true when only ordinary edges point at a copy", () => {
    const graph = new NpmGraph({ packages: { "": {}, "node_modules/a": { version: "1.0.0", dependencies: { lib: "^1" } }, "node_modules/lib": { version: "1.0.0", peer: true } } });
    const result = pinnedManifests(graph, [{ copy: graph.copies().find((copy) => copy.name === "lib")!, target: "1.1.0" }], new Map([["", {}]]), repositoryOverrides({}));
    expect(result.get("")).toEqual({ overrides: { "lib@1.0.0": "1.1.0" } });
  });

  it("keeps distinct root/workspace peer targets separate", () => {
    const graph = new NpmGraph({ packages: { "": {}, ws: {}, "node_modules/a": { version: "1.0.0", peerDependencies: { lib: "^1" } }, "node_modules/lib": { version: "1.0.0" }, "ws/node_modules/a": { version: "2.0.0", peerDependencies: { lib: "^2" } }, "ws/node_modules/lib": { version: "2.0.0" } } });
    const pins = graph.copies().filter((copy) => copy.name === "lib").map((copy) => ({ copy, target: copy.version === "1.0.0" ? "1.1.0" : "2.1.0" }));
    const result = pinnedManifests(graph, pins, new Map([["", {}], ["ws", {}]]), repositoryOverrides({}));
    expect(result.get("")).toEqual({ devDependencies: { lib: "1.1.0" } });
    expect(result.get("ws")).toEqual({ devDependencies: { lib: "2.1.0" } });
  });

  it("reports a nested peer that cannot be represented by a repository declaration", () => {
    const graph = new NpmGraph({ packages: { "": {}, "node_modules/a": { version: "1.0.0", peerDependencies: { lib: "^1" } }, "node_modules/a/node_modules/lib": { version: "1.0.0" } } });
    expect(() => pinnedManifests(graph, [{ copy: graph.copies()[1]!, target: "1.1.0" }], new Map([["", {}]]), repositoryOverrides({}))).toThrow("unsupported npm peer placement");
  });

  it.each(["success", "failure", "rewrite"])("restores formatting and temporary declarations after %s", async (outcome) => {
    const dir = await mkdtemp(join(process.cwd(), ".exact-test-"));
    dirs.push(dir);
    const original = '{\r\n\t"dependencies": {\r\n\t\t"a": "^1",\r\n\t\t"b": "~1"\r\n\t}\r\n}';
    await writeFile(join(dir, "package.json"), original);
    let restored = false;
    const run = resolveExact(dir, new Map([["", original]]), new Map([["", { dependencies: { a: "1.1.0", b: "1.1.0" }, devDependencies: { peer: "1.1.0" } }]]), async () => {
      const text = await readFile(join(dir, "package.json"), "utf8");
      expect(text).toContain('\r\n\t"dependencies"');
      expect(text.endsWith("\n")).toBe(false);
      expect(JSON.parse(text)).toEqual({ dependencies: { a: "1.1.0", b: "1.1.0" }, devDependencies: { peer: "1.1.0" } });
      if (outcome === "failure") throw new Error("npm failed");
      if (outcome === "rewrite") await writeFile(join(dir, "package.json"), json({ surprise: true }));
    }, async () => {
      restored = true;
      expect(await readFile(join(dir, "package.json"), "utf8")).toBe(original);
    });
    if (outcome === "success") await run;
    else await expect(run).rejects.toThrow(outcome === "failure" ? "npm failed" : "npm rewrote");
    expect(restored).toBe(outcome === "success");
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(original);
  });
  it("keeps a plain root override consistent with its temporary direct spec", () => {
    const manifest = { dependencies: { lib: "^1.0.0" }, overrides: { lib: "^1.0.0" } };
    const graph = new NpmGraph({ packages: { "": manifest, "node_modules/lib": { version: "1.0.0" } } });
    const result = pinnedManifests(graph, [{ copy: graph.copies()[0]!, target: "1.0.0" }], new Map([["", manifest]]), repositoryOverrides(manifest));
    expect(result.get("")).toEqual({ dependencies: { lib: "1.0.0" }, overrides: { lib: "1.0.0" } });
    expect(manifest.overrides.lib).toBe("^1.0.0");
  });

  it.each(["^8", "$vite"])("preserves peer-anchor child rules and self-reference %s", (self) => {
    const manifest = { overrides: { vite: { ".": self, child: "2.0.0" } } };
    const graph = new NpmGraph({ packages: { "": manifest, "node_modules/parent": { version: "1.0.0", peerDependencies: { vite: "^8" } }, "node_modules/vite": { version: "8.3.2" } } });
    const result = pinnedManifests(graph, [{ copy: graph.copies().find((copy) => copy.name === "vite")!, target: "8.3.3" }], new Map([["", manifest]]), repositoryOverrides(manifest));
    expect(result.get("")).toEqual({ overrides: { vite: { ".": self.startsWith("$") ? self : "8.3.3", child: "2.0.0" } }, devDependencies: { vite: "8.3.3" } });
    expect(manifest.overrides.vite["."]).toBe(self);
  });

  it("keeps an existing plain peer override compatible with the temporary root declaration", () => {
    const manifest = { overrides: { vite: "^8" } };
    const graph = new NpmGraph({ packages: { "": manifest, "node_modules/parent": { version: "1.0.0", peerDependencies: { vite: "^8" } }, "node_modules/vite": { version: "8.3.2" } } });
    const result = pinnedManifests(graph, [{ copy: graph.copies().find((copy) => copy.name === "vite")!, target: "8.3.3" }], new Map([["", manifest]]), repositoryOverrides(manifest));
    expect(result.get("")).toEqual({ overrides: { vite: "8.3.3" }, devDependencies: { vite: "8.3.3" } });
    expect(manifest.overrides.vite).toBe("^8");
  });

});
