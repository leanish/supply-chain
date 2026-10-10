import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { changedSince, exportCommit, sameTreeAs } from "../src/git-copies.ts";

let root: string;
let workingCopy: WorkingCopy;
let first: string;

function git(args: ReadonlyArray<string>): string {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: workingCopy.path, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "git-copies-"));
  workingCopy = { projectId: "leanish/widget", path: join(root, "wc"), branch: "main", headSha: "", gitDir: join(root, "git") };
  spawnSync("git", ["init", "-q", "-b", "main", "--separate-git-dir", workingCopy.gitDir!, workingCopy.path]);
  await writeFile(join(workingCopy.path, "package.json"), '{"name":"a"}\n');
  await writeFile(join(workingCopy.path, ".gitignore"), "build/\n");
  // Attributes `git archive` would apply: a dropped file and a substituted one.
  await writeFile(join(workingCopy.path, ".gitattributes"), "hidden.gradle export-ignore\nversion.txt export-subst\n");
  await writeFile(join(workingCopy.path, "hidden.gradle"), "dependencies {}\n");
  await writeFile(join(workingCopy.path, "version.txt"), "$Format:%H$\n");
  await writeFile(join(workingCopy.path, "gradlew"), "#!/bin/sh\n");
  await chmod(join(workingCopy.path, "gradlew"), 0o755);
  await symlink("package.json", join(workingCopy.path, "link.json"));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "one"]);
  first = git(["rev-parse", "HEAD"]);
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("git copies", () => {
  it("exports a commit's files into a fresh directory, and removes it", async () => {
    await writeFile(join(workingCopy.path, "package.json"), '{"name":"b"}\n');
    const copy = await exportCommit(workingCopy, first);
    expect(await readFile(join(copy.dir, "package.json"), "utf8")).toBe('{"name":"a"}\n');
    // Exactly as committed: no export-ignore, no export-subst, modes and links kept.
    expect(await readFile(join(copy.dir, "hidden.gradle"), "utf8")).toBe("dependencies {}\n");
    expect(await readFile(join(copy.dir, "version.txt"), "utf8")).toBe("$Format:%H$\n");
    expect((await lstat(join(copy.dir, "gradlew"))).mode & 0o111).not.toBe(0);
    expect(await readlink(join(copy.dir, "link.json"))).toBe("package.json");
    await copy.remove();
    await expect(readFile(join(copy.dir, "package.json"))).rejects.toThrow();
    await expect(exportCommit(workingCopy, "HEAD")).rejects.toThrow("full commit sha");
  });

  it("lists what the working tree changed since a commit, untracked files included and ignored ones not", async () => {
    await writeFile(join(workingCopy.path, "package.json"), '{"name":"b"}\n');
    await writeFile(join(workingCopy.path, "new.txt"), "x\n");
    spawnSync("mkdir", ["-p", join(workingCopy.path, "build")]);
    await writeFile(join(workingCopy.path, "build", "out.txt"), "x\n");
    expect(await changedSince(workingCopy, first)).toEqual(["new.txt", "package.json"]);
    expect(await sameTreeAs(workingCopy, first)).toBe(false);
    await writeFile(join(workingCopy.path, "package.json"), '{"name":"a"}\n');
    await rm(join(workingCopy.path, "new.txt"));
    expect(await sameTreeAs(workingCopy, first)).toBe(true);
  });

  it("refuses a tree with an entry under its own symlink, case-insensitively: a symlink A and a file under a/", async () => {
    const input = (args: ReadonlyArray<string>, stdin: string) => {
      const result = spawnSync("git", ["--git-dir", workingCopy.gitDir!, ...args], { input: stdin, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const file = input(["hash-object", "-w", "--stdin"], "written through the link\n");
    const link = input(["hash-object", "-w", "--stdin"], "/tmp");
    const sub = input(["mktree"], `100644 blob ${file}\tfile\n`);
    const root = input(["mktree"], `120000 blob ${link}\tA\n040000 tree ${sub}\ta\n`);
    const commit = input(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit-tree", root, "-m", "collision"], "");
    await expect(exportCommit(workingCopy, commit)).rejects.toThrow("has a/file under its symlink A");
    const twins = input(["mktree"], `100644 blob ${file}\tREADME\n100644 blob ${file}\treadme\n`);
    const twinCommit = input(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit-tree", twins, "-m", "twins"], "");
    await expect(exportCommit(workingCopy, twinCommit)).rejects.toThrow("has paths that collide: README and readme");
  });
});
