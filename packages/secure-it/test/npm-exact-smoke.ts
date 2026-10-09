/** Manual registry smoke: Node >=24, weekly PATH's npm 11.19.1. Not run by Vitest; never publishes or touches git. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runProcess } from "../../ci/src/process.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { safePath } from "../../remediation/src/local-files.ts";
import { NpmGraph } from "../../remediation/src/npm-graph.ts";
import { materializeInCopy } from "../src/npm-materialize.ts";
import { npmWindowFor } from "../src/npm-window.ts";
import { planFor } from "../src/plan.ts";

const sources = process.argv.slice(2);
if (sources.length === 0) throw new Error("Usage: node packages/secure-it/test/npm-exact-smoke.ts <sc-repro> <dtv-repro> (manifest/lock directories only)");
const npm = await runProcess("npm", ["--version"]);
if (npm.code !== 0) throw new Error(npm.stderr);
console.log(JSON.stringify({ npm: npm.stdout.trim(), expected: "11.19.1", target: "vite@8.3.3" }));

for (const source of sources) {
  const dir = await mkdtemp(join(process.cwd(), ".npm-exact-smoke-"));
  try {
    const lockText = await readFile(join(source, "package-lock.json"), "utf8");
    const graph = new NpmGraph(JSON.parse(lockText));
    const copies = graph.copies().filter((copy) => copy.name === "vite" && copy.version === "8.3.2");
    if (copies.length === 0) throw new Error(`${source}: expected a Vite 8.3.2 base copy`);
    const files: Record<string, string> = { "package-lock.json": lockText };
    for (const owner of Object.keys(graph.packages).filter((path) => !path.includes("node_modules/") && graph.packages[path]?.link !== true)) {
      const path = owner === "" ? "package.json" : `${owner}/package.json`;
      if (!safePath(path)) throw new Error(`unsafe manifest path ${path}`);
      files[path] = await readFile(join(source, path), "utf8");
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    const base: Tree = { id: "smoke-base", read: async (path) => files[path], list: async () => [] };
    const plan = await planFor([{
      ecosystem: "npm", name: "vite", from: "8.3.2", locations: copies.map((copy) => copy.path),
      targets: ["GHSA-rq7h-c2jc-7f22"], unfixable: [], malicious: false, severity: "MODERATE", problem: undefined,
      to: { version: "8.3.3", line: "8", aged: false, major: false, blockers: [] },
    }], { lockfiles: new Map([["package-lock.json", JSON.parse(lockText)]]), gradle: undefined, tagCommit: async () => undefined });
    const now = new Date();
    const window = await npmWindowFor(plan, 7, [], now, (url, init) => fetch(url, init), new Map([["package-lock.json", JSON.parse(lockText)]]));
    const computed = await materializeInCopy({ releaseAgeDays: 7, now }, dir, base, plan, window.exclude,
      (cwd, args) => runProcess("npm", [...args], { cwd }));
    const landed = new NpmGraph(JSON.parse(computed.get("package-lock.json")!));
    console.log(JSON.stringify({ source, outcome: "exact-and-restored", moves: plan.moves,
      vite: landed.copies().filter((copy) => copy.name === "vite"),
      postcss: landed.copies().filter((copy) => copy.name === "postcss"),
      manifest: JSON.parse(computed.get("package.json")!), exclusions: window.exclude }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
