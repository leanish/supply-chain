/** Verify registry signatures in clean npm projects, without repository npm configuration or Git execution. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix } from "node:path";

import { readSettings } from "./gate.ts";
import { sourcesOf } from "./inventory.ts";
import { isObject } from "./json.ts";
import { lockedPackages, sourceProblems } from "./npm-lock.ts";
import { runProcess, type RunProcess } from "./process.ts";
import type { Tree } from "./tree.ts";

const DEPENDENCIES = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

export interface SignatureOptions {
  readonly run?: RunProcess;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (text: string) => void;
}

/** Each configured lockfile gets its own project, cache and home, removed even when npm fails. */
export async function npmSignatures(tree: Tree, options: SignatureOptions = {}): Promise<string[]> {
  const { config } = await readSettings(tree);
  const { lockfiles } = await sourcesOf(tree, config);
  const run = options.run ?? runProcess;
  for (const lockfile of lockfiles) {
    safePath(lockfile);
    const lockName = basename(lockfile);
    if (lockName !== "package-lock.json" && lockName !== "npm-shrinkwrap.json") {
      throw new Error(`unsupported npm lockfile: ${lockfile}`);
    }
    const text = await requiredFile(tree, lockfile);
    const lock: unknown = JSON.parse(text);
    const packages = lockedPackages(lock);
    const rejected = sourceProblems(packages, config.npm.registries);
    if (rejected.length > 0) return rejected;
    const entries = (lock as { packages: Record<string, Record<string, unknown>> }).packages;
    const workspaces = Object.keys(entries).filter((path) => path !== "" && !path.split("/").includes("node_modules"));
    workspaces.forEach(safePath);
    checkLinks(entries, workspaces);
    const manifests = await manifestsOf(tree, dirname(lockfile), workspaces);
    for (const [path, entry] of Object.entries(entries)) checkDependencySources(entry, path, workspaces);
    const registryArgs = registryFlags(config.npm.registries, packages);
    // npm's prefix must match the physical cwd (macOS's temporary directory has a symlink alias).
    const staging = await realpath(await mkdtemp(join(tmpdir(), "supply-chain-signatures-")));
    try {
      const project = join(staging, "project");
      await mkdir(project);
      for (const [path, manifest] of manifests) {
        const file = join(project, path, "package.json");
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(manifest));
      }
      await writeFile(join(project, lockName), text);
      // npm refuses to load the same file as both user and global configuration.
      const globalConfig = join(staging, "global.npmrc");
      await writeFile(globalConfig, "");
      const flags = [
        `--prefix=${project}`, "--userconfig=/dev/null", `--globalconfig=${globalConfig}`, "--git=/usr/bin/false",
        "--ignore-scripts", "--bin-links=false", "--no-audit", "--no-fund", `--cache=${join(staging, "cache")}`, ...registryArgs,
      ];
      for (const command of [["ci"], ["audit", "signatures"]]) {
        const args = [...command, ...flags];
        const result = await run("npm", args, { cwd: project, env: npmEnvironment(options.env ?? process.env, staging) });
        options.log?.(result.stdout);
        if (result.code !== 0) {
          return [`npm ${command.join(" ")} in ${dirname(lockfile)} failed: ${result.stderr.trim().split("\n").slice(-3).join(" / ")}`];
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return [];
}

async function manifestsOf(tree: Tree, root: string, workspaces: ReadonlyArray<string>): Promise<Map<string, Record<string, unknown>>> {
  const manifests = new Map<string, Record<string, unknown>>();
  for (const path of ["", ...workspaces]) {
    const file = posix.join(root, path, "package.json");
    const manifest: unknown = JSON.parse(await requiredFile(tree, file));
    if (!isObject(manifest)) throw new Error(`${file} isn't a package manifest`);
    checkDependencySources(manifest, path, workspaces);
    // Only the root may discover workspaces, using the exact directories recorded in this lockfile.
    const staged = { ...manifest };
    delete staged["workspaces"];
    if (path === "" && workspaces.length > 0) staged["workspaces"] = [...workspaces];
    manifests.set(path, staged);
  }
  return manifests;
}

function checkDependencySources(entry: Record<string, unknown>, owner: string, workspaces: ReadonlyArray<string>): void {
  for (const field of DEPENDENCIES) {
    const dependencies = entry[field];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies)) throw new Error(`${owner || "."}: invalid ${field}`);
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== "string") throw new Error(`${owner || "."}: ${name} has no npm specifier`);
      if (spec.startsWith("file:")) {
        const target = posix.normalize(posix.join(owner, spec.slice(5)));
        if (workspaces.includes(target)) continue;
      }
      // Registry ranges/tags and npm aliases only. Git, tarball URLs and external files are refused before npm runs.
      const alias = /^npm:(?:@[\w.-]+\/)?[\w.-]+(?:@([^:/\\]+))?$/.exec(spec);
      const range = spec.startsWith("npm:") ? (alias === null ? "" : alias[1] ?? "*") : spec;
      if (range !== "" && !/[:/\\]/.test(range)) continue;
      throw new Error(`${owner || "."}: ${name} uses non-registry dependency '${spec}'`);
    }
  }
}

function checkLinks(entries: Record<string, Record<string, unknown>>, workspaces: ReadonlyArray<string>): void {
  for (const [path, entry] of Object.entries(entries)) {
    safePath(path || "package.json");
    if (entry["link"] !== true) continue;
    const target = entry["resolved"];
    if (typeof target !== "string" || !workspaces.includes(target)) throw new Error(`${path} links outside the staged workspaces`);
  }
}

function registryFlags(registries: ReadonlyArray<string>, packages: ReturnType<typeof lockedPackages>): string[] {
  if (registries.length === 0) throw new Error("npm signatures need an allowed registry");
  for (const registry of registries) {
    const url = new URL(registry);
    if (!["https:", "http:"].includes(url.protocol) || url.username !== "" || url.password !== "" || /\s/.test(registry)) {
      throw new Error("npm signatures need HTTP(S) registries without credentials or whitespace");
    }
  }
  const scopes = new Map<string, string>();
  for (const pkg of packages) {
    const scope = /^(@[\w.-]+)\//.exec(pkg.name)?.[1];
    if (scope === undefined || pkg.bundled) continue;
    const registry = [...registries].sort((a, b) => b.length - a.length).find((url) => pkg.resolved?.startsWith(`${url}/`))!;
    if (scopes.has(scope) && scopes.get(scope) !== registry) throw new Error(`${scope} uses more than one registry in this lockfile`);
    scopes.set(scope, registry);
  }
  return [`--registry=${registries[0]}`, ...[...scopes].map(([scope, registry]) => `--${scope}:registry=${registry}`)];
}

function npmEnvironment(env: NodeJS.ProcessEnv, staging: string): NodeJS.ProcessEnv {
  // An allowlist also removes NODE_OPTIONS, npm config, proxies and credentials, including future config variables.
  const allowed = new Set(["PATH", "SystemRoot", "WINDIR", "PATHEXT", "LANG"]);
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key))), HOME: staging, USERPROFILE: staging, TMPDIR: staging, TMP: staging, TEMP: staging };
}

function safePath(path: string): void {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "" || part === ".")) {
    throw new Error(`npm signature path must stay inside its project: '${path}'`);
  }
}

async function requiredFile(tree: Tree, path: string): Promise<string> {
  const text = await tree.read(path);
  if (text === undefined) throw new Error(`${path} is missing from ${tree.id}`);
  return text;
}
