import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { npmSignatures } from "../src/npm-signatures.ts";
import { runProcess, type RunProcess } from "../src/process.ts";
import { workingTree } from "../src/tree.ts";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "signature-test-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function file(path: string, content: unknown): Promise<void> {
  const target = join(repo, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
}

async function project(root = "", entries: Record<string, object> = {}, manifest: object = { name: "app", version: "1.0.0" }): Promise<void> {
  await file(join(root, "package.json"), manifest);
  await file(join(root, "package-lock.json"), { name: "app", version: "1.0.0", lockfileVersion: 3, packages: { "": manifest, ...entries } });
}

const success = { code: 0, stdout: "verified\n", stderr: "" };
const absent = async (path: string) => stat(path).then(() => false, (err: NodeJS.ErrnoException) => {
  if (err.code !== "ENOENT") throw err;
  return true;
});

describe("isolated npm signatures", () => {
  it("rejects a hostile .npmrc's git executable without running it, even with a registry-only lockfile", async () => {
    const marker = join(repo, "executed");
    const executable = join(repo, "hostile-git");
    await file("hostile-git", `#!/bin/sh\nprintf attacked > '${marker}'\nexit 1\n`);
    await chmod(executable, 0o755);
    await file(".npmrc", `git=${executable}\n`);
    await project("", {}, { name: "app", version: "1.0.0", dependencies: { evil: "git+https://example.invalid/evil.git" } });
    // Positive attack control: scriptless npm still executes the project's configured git command, without a network request.
    const env = { PATH: process.env["PATH"], HOME: repo };
    await file("global.npmrc", "");
    const unsafe = await runProcess("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--userconfig=/dev/null", `--globalconfig=${join(repo, "global.npmrc")}`, `--cache=${join(repo, "cache")}`], { cwd: repo, env });
    expect(unsafe.code).not.toBe(0);
    expect(await readFile(marker, "utf8")).toBe("attacked");
    await rm(marker);
    await expect(npmSignatures(workingTree(repo), { env })).rejects.toThrow("non-registry dependency");
    expect(await absent(marker)).toBe(true);
  });

  it("uses clean files and fixed configuration for both install and audit, and cleans up", async () => {
    await project("", {}, { name: "app", version: "1.0.0", scripts: { prepare: "touch executed" } });
    await file(".npmrc", "git=./hostile\nregistry=https://evil.invalid\nproxy=https://evil.invalid\n");
    await file("npm-shrinkwrap.json", "hostile alternative lockfile");
    const commands: string[][] = [];
    let staging = "";
    const run: RunProcess = async (command, args, options) => {
      expect(command).toBe("npm");
      const cwd = options!.cwd!;
      staging = dirname(cwd);
      expect(cwd).not.toBe(repo);
      expect(await absent(join(cwd, ".npmrc"))).toBe(true);
      expect(await absent(join(cwd, "npm-shrinkwrap.json"))).toBe(true);
      expect(await readFile(join(cwd, "package-lock.json"), "utf8")).toBe(await readFile(join(repo, "package-lock.json"), "utf8"));
      expect(args).toEqual(expect.arrayContaining([`--prefix=${cwd}`, "--git=/usr/bin/false", "--userconfig=/dev/null", `--globalconfig=${join(staging, "global.npmrc")}`, "--ignore-scripts", "--bin-links=false", "--registry=https://registry.npmjs.org"]));
      expect(await readFile(join(staging, "global.npmrc"), "utf8")).toBe("");
      expect(options!.env).toEqual({ PATH: "/usr/bin:/bin", HOME: staging, USERPROFILE: staging, TMPDIR: staging, TMP: staging, TEMP: staging });
      commands.push([...args]);
      return success;
    };
    const env = { PATH: "/usr/bin:/bin", GITHUB_TOKEN: "write", NODE_OPTIONS: "--require=./hostile", npm_config_git: "./hostile", NPM_CONFIG_USERCONFIG: "hostile", HTTPS_PROXY: "https://evil.invalid" };
    expect(await npmSignatures(workingTree(repo), { run, env })).toEqual([]);
    expect(commands.map((args) => args.slice(0, args[0] === "ci" ? 1 : 2))).toEqual([["ci"], ["audit", "signatures"]]);
    expect(await absent(staging)).toBe(true);
  });

  it("installs a legitimate workspace using only staged manifests, without scripts or network", async () => {
    const manifest = { name: "app", version: "1.0.0", workspaces: ["packages/*"], dependencies: { widget: "file:packages/widget" } };
    await project("", {
      "packages/widget": { name: "widget", version: "1.0.0" },
      "node_modules/widget": { resolved: "packages/widget", link: true },
    }, manifest);
    await file("packages/widget/package.json", { name: "widget", version: "1.0.0", scripts: { prepare: "touch executed" } });
    // Let npm generate the workspace metadata; all dependencies are local and offline.
    await file("global.npmrc", "");
    const locked = await runProcess("npm", ["install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--userconfig=/dev/null", `--globalconfig=${join(repo, "global.npmrc")}`, `--cache=${join(repo, "cache")}`], { cwd: repo, env: { PATH: process.env["PATH"], HOME: repo } });
    expect(locked.code, locked.stderr).toBe(0);
    await file("packages/widget/package.json", { name: "widget", version: "1.0.0", workspaces: ["../../outside/*"], scripts: { prepare: "touch executed" } });
    const run: RunProcess = async (command, args, options) => {
      const cwd = options!.cwd!;
      expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).workspaces).toEqual(["packages/widget"]);
      expect(JSON.parse(await readFile(join(cwd, "packages/widget/package.json"), "utf8")).workspaces).toBeUndefined();
      if (args[0] !== "ci") return success;
      const result = await runProcess(command, args, options);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr, result.stdout).not.toContain("executed");
      expect(await absent(join(cwd, "packages/widget/executed"))).toBe(true);
      return result;
    };
    expect(await npmSignatures(workingTree(repo), { run })).toEqual([]);
  });

  it("checks nested lockfiles independently and uses only gate-approved scoped registries", async () => {
    await file(".github/supply-chain.json", { npm: { lockfiles: ["package-lock.json", "tools/cli/package-lock.json"], registries: ["https://registry.npmjs.org", "https://registry.example.com/npm"] } });
    await project();
    await project("tools/cli", { "node_modules/@acme/lib": { version: "1.0.0", resolved: "https://registry.example.com/npm/@acme/lib/-/lib-1.0.0.tgz" } });
    const roots = new Set<string>();
    const run: RunProcess = async (_command, args, options) => {
      roots.add(options!.cwd!);
      const lock = JSON.parse(await readFile(join(options!.cwd!, "package-lock.json"), "utf8"));
      if (lock.packages["node_modules/@acme/lib"] !== undefined) expect(args).toContain("--@acme:registry=https://registry.example.com/npm");
      return success;
    };
    expect(await npmSignatures(workingTree(repo), { run })).toEqual([]);
    expect(roots.size).toBe(2);
  });

  it("runs actual signature auditing even with automatic install auditing disabled", async () => {
    await project();
    const run: RunProcess = (command, args, options) => runProcess(command, [...args, "--offline"], options);
    const problems = await npmSignatures(workingTree(repo), { run });
    // An empty tree fails inside signature verification, before any registry request.
    expect(problems).toEqual([expect.stringContaining("npm audit signatures in . failed:")]);
    expect(problems[0]).toContain("found no installed dependencies to audit");
  });

  it("rejects traversal, external workspace links, Git lock sources and tarball manifests before invoking npm", async () => {
    const run: RunProcess = async () => { throw new Error("npm must not run"); };
    await file(".github/supply-chain.json", { npm: { lockfiles: ["../package-lock.json"] } });
    await expect(npmSignatures(workingTree(repo), { run })).rejects.toThrow("must stay inside");
    await rm(join(repo, ".github/supply-chain.json"));
    await project("", { "node_modules/widget": { link: true, resolved: "../outside" } });
    await expect(npmSignatures(workingTree(repo), { run })).rejects.toThrow("links outside");
    await project("", { "node_modules/widget": { version: "1.0.0", resolved: "git+https://example.invalid/widget.git" } });
    expect(await npmSignatures(workingTree(repo), { run })).toEqual([expect.stringContaining("doesn't come from an allowed registry")]);
    await project("", {}, { dependencies: { widget: "https://example.invalid/widget.tgz" } });
    await expect(npmSignatures(workingTree(repo), { run })).rejects.toThrow("non-registry dependency");
  });

  it("reports an npm failure and removes its project without auditing", async () => {
    await project();
    let staging = "";
    let calls = 0;
    const run: RunProcess = async (_command, _args, options) => {
      staging = dirname(options!.cwd!);
      calls++;
      return { code: 1, stdout: "", stderr: "invalid registry signature" };
    };
    expect(await npmSignatures(workingTree(repo), { run })).toEqual(["npm ci in . failed: invalid registry signature"]);
    expect(calls).toBe(1);
    expect(await absent(staging)).toBe(true);
  });
});
