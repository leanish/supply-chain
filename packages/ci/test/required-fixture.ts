/** Synthetic October 9 registry and scanner, shared by gate and secure-it requirement tests. */
import { readFile } from "node:fs/promises";

import type { GateEnvironment } from "../src/gate.ts";
import type { Tree } from "../src/tree.ts";
import { fakeFetch } from "./fake-fetch.ts";

export const NOW = new Date("2026-10-09T05:05:00Z");
export const OLD = "2026-09-01T00:00:00Z";
export const YOUNG = "2026-10-06T00:00:00Z";
export const FIXED = "GHSA-rq7h-c2jc-7f22";
export const metadata = { _npmUser: { name: "maintainer" }, dist: {} };
export const vite = { time: { "8.3.2": OLD, "8.3.3": YOUNG }, versions: {
  "8.3.2": { ...metadata, dependencies: { postcss: "^8.5.28" } },
  "8.3.3": { ...metadata, dependencies: { postcss: "^8.5.29" } },
} };
export const postcss = { time: { "8.5.28": OLD, "8.5.29": YOUNG, "8.5.30": YOUNG }, versions: {
  "8.5.28": metadata, "8.5.29": metadata, "8.5.30": metadata,
} };
export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export function locked(name: string, version: string) {
  return { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: "sha512-AAAA" };
}
export function files(version = "8.3.2", child: string | undefined = "8.5.28"): Record<string, string> {
  const manifest = { devDependencies: { vite: `^${version}` } };
  return { "package.json": json(manifest), "package-lock.json": json({ lockfileVersion: 3, packages: {
    "": manifest, "node_modules/vite": { ...locked("vite", version), dependencies: { postcss: "^8.5.28" } },
    ...(child === undefined ? {} : { "node_modules/postcss": locked("postcss", child) }),
  } }) };
}
export function tree(files: Record<string, string>, id = "base"): Tree {
  return { id, read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)) };
}
export function environment(options: { docs?: Record<string, { time: Record<string, unknown>; versions: Record<string, unknown> }>; affected?: Record<string, string[]> } = {}) {
  const docs = { vite, postcss, ...options.docs };
  const routes = Object.fromEntries(Object.entries(docs).flatMap(([name, doc]) => [
    [`https://registry.npmjs.org/${encodeURIComponent(name)}`, { body: doc }],
    ...Object.keys(doc.versions).map((version) => [`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { body: {} }]),
  ]));
  const scans: string[][] = [];
  const env: GateEnvironment = { fetch: fakeFetch(routes), now: () => NOW, osvScanner: "fake-scanner", githubToken: undefined,
    run: async (command, args) => {
      if (command !== "fake-scanner") throw new Error(`unexpected command ${command}`);
      if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
      const path = args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, "");
      const inventory = JSON.parse(await readFile(path, "utf8")) as { results: Array<{ packages: Array<{ package: { name: string; version: string } }> }> };
      const requested = inventory.results[0]!.packages;
      scans.push(requested.map(({ package: pkg }) => `${pkg.name}@${pkg.version}`));
      const affected = options.affected ?? { "vite@8.3.2": [FIXED] };
      const packages = requested.map(({ package: pkg }) => ({ package: pkg, vulnerabilities: (affected[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id })) }));
      return { code: 0, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
    },
  };
  return { env, scans };
}

/** Two security roots must change together because they share an exact child requirement. */
export function securityBatch() {
  const root = { ...vite, versions: {
    "8.3.2": { ...metadata, dependencies: { postcss: "8.5.28" } },
    "8.3.3": { ...metadata, dependencies: { postcss: "8.5.29" } },
  } };
  const batchFiles = (version: string, child: string) => {
    const manifest = { devDependencies: { vite: `^${version}`, bundler: `^${version}` } };
    return { "package.json": json(manifest), "package-lock.json": json({ lockfileVersion: 3, packages: {
      "": manifest, "node_modules/vite": locked("vite", version), "node_modules/bundler": locked("bundler", version),
      "node_modules/postcss": locked("postcss", child),
    } }) };
  };
  return { docs: { vite: root, bundler: root }, base: batchFiles("8.3.2", "8.5.28"), head: batchFiles("8.3.3", "8.5.29"),
    affected: { "vite@8.3.2": [FIXED], "bundler@8.3.2": [FIXED] } };
}
