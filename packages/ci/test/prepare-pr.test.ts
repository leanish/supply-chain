import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runProcess } from "../src/process.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/prepare-pr.sh", import.meta.url));

let root: string;
const git = async (cwd: string, ...args: string[]) => {
  const result = await runProcess("git", ["-c", "user.email=dev@example.com", "-c", "user.name=dev", ...args], { cwd });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

/** A clone of `origin` (which has refs/pull/<n>/head) in a fresh directory, then the script's `key=value` output. */
async function prepare(name: string, number: number, head: string, base: string): Promise<Record<string, string>> {
  const clone = join(root, name);
  await git(root, "clone", "--quiet", join(root, "origin.git"), clone);
  const result = await runProcess(SCRIPT, [String(number), head, base], { cwd: clone });
  if (result.code !== 0) throw new Error(`prepare-pr.sh exited ${result.code}: ${result.stderr}`);
  return Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=") as [string, string]));
}

let base: string;
let mergeable: string;
let conflicting: string;
let branchPoint: string;

describe("prepare-pr.sh", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "supply-chain-prepare-"));
    const work = join(root, "work");
    await git(root, "init", "--quiet", "--bare", "origin.git");
    await git(root, "init", "--quiet", "-b", "main", work);
    await writeFile(join(work, "a.txt"), "one\n");
    await git(work, "add", "-A");
    await git(work, "commit", "--quiet", "-m", "start");
    branchPoint = await git(work, "rev-parse", "HEAD");
    // PR 1 changes another file; PR 2 changes a.txt, which main changes too.
    await git(work, "checkout", "--quiet", "-b", "pr1");
    await writeFile(join(work, "b.txt"), "pr\n");
    await git(work, "add", "-A");
    await git(work, "commit", "--quiet", "-m", "pr 1");
    mergeable = await git(work, "rev-parse", "HEAD");
    await git(work, "checkout", "--quiet", "-b", "pr2", branchPoint);
    await writeFile(join(work, "a.txt"), "pr two\n");
    await git(work, "commit", "--quiet", "-am", "pr 2");
    conflicting = await git(work, "rev-parse", "HEAD");
    await git(work, "checkout", "--quiet", "main");
    await writeFile(join(work, "a.txt"), "main moved\n");
    await git(work, "commit", "--quiet", "-am", "main moves");
    base = await git(work, "rev-parse", "HEAD");
    await git(work, "push", "--quiet", join(root, "origin.git"), "main", `${mergeable}:refs/pull/1/head`, `${conflicting}:refs/pull/2/head`);
  });

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("merges the PR onto the base the same way in every job", async () => {
    const first = await prepare("job-a", 1, mergeable, base);
    const second = await prepare("job-b", 1, mergeable, base);
    expect(first["base"]).toBe(base);
    expect(first["head"]).not.toBe(mergeable);
    expect(second).toEqual(first);
  });

  it("falls back to the PR head against its merge base when the merge conflicts", async () => {
    expect(await prepare("job-c", 2, conflicting, base)).toEqual({ base: branchPoint, head: conflicting });
  });

  it("refuses a PR whose head moved since the plan", async () => {
    await expect(prepare("job-d", 1, conflicting, base)).rejects.toThrow("exited 3");
  });
});
