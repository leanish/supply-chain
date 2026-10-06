// Copied from leanish/leanish-development core/runtime/test/unit/local-git-workspace.test.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: `RepoSource` instead of catalog-it's `Project`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RepoSource as Project } from "../src/types/repo-source.ts";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkingCopy } from "../src/types/working-copy.ts";
import { LocalGitWorkspace } from "../src/working-copy/local-git-workspace.ts";

// The clone-auth *decision* logic (host match, header, https-only) is covered
// exhaustively in git-clone-auth.test.ts. Here we exercise the real `git` CLI
// to confirm (a) cloning still works and (b) a supplied token never lands in
// the working copy's .git/config — the invariant the one-shot `-c` mechanism
// exists to guarantee.
const hasGit = spawnSync("git", ["--version"]).status === 0;

function git(cwd: string, args: ReadonlyArray<string>): void {
  const r = spawnSync("git", [...args], { cwd, stdio: "ignore" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
}

function gitOut(cwd: string, args: ReadonlyArray<string>): string {
  const r = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  return r.stdout.trim();
}

describe.skipIf(!hasGit)("LocalGitWorkspace (real git)", () => {
  const tmpDirs: string[] = [];
  const TOKEN = "super-secret-clone-token";

  function makeSourceRepo(): string {
    const src = mkdtempSync(join(tmpdir(), "lgw-src-"));
    tmpDirs.push(src);
    git(src, ["init", "-b", "main"]);
    git(src, ["config", "user.email", "test@example.com"]);
    git(src, ["config", "user.name", "Test"]);
    writeFileSync(join(src, "README.md"), "hello\n");
    git(src, ["add", "."]);
    git(src, ["commit", "-m", "init"]);
    return src;
  }

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "lgw-root-"));
    tmpDirs.push(root);
    return root;
  }

  // A stand-in `git` that always fails, so we can assert what the workspace
  // puts in the error message without reaching the network.
  function makeFailingGit(): string {
    const dir = mkdtempSync(join(tmpdir(), "lgw-fakegit-"));
    tmpDirs.push(dir);
    const bin = join(dir, "git");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    return bin;
  }

  function project(url: string): Project {
    return { id: "acme/widget", source: { url, branch: "main" } };
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clones a repo and never persists the supplied token in .git/config", async () => {
    const src = makeSourceRepo();
    // gitAuth is present, but a local-path source.url does not match host
    // 'github.com', so no token is attached — and none must ever appear on
    // disk regardless of host.
    const ws = new LocalGitWorkspace({
      workspaceRoot: makeRoot(),
      gitAuth: { host: "github.com", token: TOKEN },
    });

    const result = await ws.sync([project(src)]);

    expect(result.report[0]).toMatchObject({ projectId: "acme/widget", outcome: "cloned" });
    const dest = result.workingCopies[0]?.path;
    if (dest === undefined) throw new Error("expected a working-copy path");
    expect(existsSync(join(dest, "README.md"))).toBe(true);

    const gitDir = result.workingCopies[0]?.gitDir;
    if (gitDir === undefined) throw new Error("expected a separate git dir");
    expect(gitDir.startsWith(dest)).toBe(false);
    expect(readFileSync(join(dest, ".git"), "utf8")).toBe(`gitdir: ${realpathSync(gitDir)}\n`);
    const config = readFileSync(join(gitDir, "config"), "utf8");
    expect(config).not.toContain("extraheader");
    expect(config).not.toContain(TOKEN);
  });

  it("re-syncs an existing checkout (fetch path) without error", async () => {
    const src = makeSourceRepo();
    const root = makeRoot();
    const proj = project(src);

    const first = await ws_(root).sync([proj]);
    expect(first.report[0]?.outcome).toBe("cloned");
    const dest = first.workingCopies[0]?.path;
    if (dest === undefined) throw new Error("expected a working-copy path");

    // A fresh instance on the same root finds the existing checkout and takes
    // the fetch/no-change path (per-process dedup is per-instance).
    const second = await ws_(root).sync([proj]);
    expect(second.report[0]?.outcome).toBe("no-change");

    // The fetch path uses the same one-shot `-c` mechanism as clone — nothing
    // credential-shaped should ever land in .git/config.
    const config = readFileSync(join(second.workingCopies[0]!.gitDir!, "config"), "utf8");
    expect(config).not.toContain("extraheader");
    expect(config).not.toContain(TOKEN);

    function ws_(workspaceRoot: string): LocalGitWorkspace {
      return new LocalGitWorkspace({ workspaceRoot, gitAuth: { host: "github.com", token: TOKEN } });
    }
  });

  it("puts a copy an earlier run left on another branch, with local changes, back on the tracked branch", async () => {
    const src = makeSourceRepo();
    const root = makeRoot();
    const first = await new LocalGitWorkspace({ workspaceRoot: root }).sync([project(src)]);
    const dest = first.workingCopies[0]!.path;
    const mainHead = gitOut(src, ["rev-parse", "HEAD"]);
    // What an agent run leaves behind: its own branch with a commit, an edit, a stray file.
    git(dest, ["checkout", "-b", "bump-it/dependency-refresh-2026-10-04"]);
    git(dest, ["config", "user.email", "agent@example.com"]);
    git(dest, ["config", "user.name", "Agent"]);
    writeFileSync(join(dest, "upgrade.txt"), "x\n");
    git(dest, ["add", "."]);
    git(dest, ["commit", "-m", "agent work"]);
    writeFileSync(join(dest, "README.md"), "edited\n");
    writeFileSync(join(dest, "stray.txt"), "left over\n");

    const second = await new LocalGitWorkspace({ workspaceRoot: root }).sync([project(src)]);

    expect(second.report[0]).toMatchObject({ outcome: "reset", toSha: mainHead });
    expect(gitOut(dest, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(gitOut(dest, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(dest, "upgrade.txt"))).toBe(false);
  });

  it("fast-forwards a tidy copy on the tracked branch", async () => {
    const src = makeSourceRepo();
    const root = makeRoot();
    await new LocalGitWorkspace({ workspaceRoot: root }).sync([project(src)]);
    writeFileSync(join(src, "CHANGELOG.md"), "next\n");
    git(src, ["add", "."]);
    git(src, ["commit", "-m", "next"]);

    const second = await new LocalGitWorkspace({ workspaceRoot: root }).sync([project(src)]);

    expect(second.report[0]).toMatchObject({ outcome: "fast-forward", toSha: gitOut(src, ["rev-parse", "HEAD"]) });
  });

  it("masks the token in git failure error messages", async () => {
    const ws = new LocalGitWorkspace({
      workspaceRoot: makeRoot(),
      gitBin: makeFailingGit(),
      gitAuth: { host: "github.com", token: TOKEN },
    });
    // Matching https host → the auth arg is attached; the fake git then fails,
    // so the workspace builds an error message that includes the argv.
    const err = await ws
      .sync([project("https://github.com/acme/widget.git")])
      .then(() => null, (e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/extraheader=<redacted>/);
    expect(err?.message).not.toContain(TOKEN);
    expect(err?.message).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
  });
});

describe.skipIf(!hasGit)("LocalGitWorkspace branch publication (real git)", () => {
  const tmpDirs: string[] = [];
  const IDENTITY = { name: "leanish", email: "5417585+leanish@users.noreply.github.com" };
  const BRANCH = "bump-it/dependency-refresh-2026-10-05";
  const savedHome = process.env["HOME"];

  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  /** A bare `origin` with `main` (README, .gitignore) and a scratch clone to make "other people's" pushes from. */
  function makeOrigin(): { origin: string; scratch: string } {
    const seed = tempDir("lgw-seed-");
    git(seed, ["init", "-q", "-b", "main"]);
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    writeFileSync(join(seed, ".gitignore"), "build/\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-q", "-m", "init"]);
    const origin = join(tempDir("lgw-origin-"), "origin.git");
    git(seed, ["clone", "-q", "--bare", seed, origin]);
    const scratch = join(tempDir("lgw-scratch-"), "scratch");
    git(seed, ["clone", "-q", origin, scratch]);
    git(scratch, ["config", "user.email", "other@example.com"]);
    git(scratch, ["config", "user.name", "Other"]);
    return { origin, scratch };
  }

  function commitIn(repo: string, file: string, content: string, message: string): void {
    writeFileSync(join(repo, file), content);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", message]);
  }

  async function synced(origin: string): Promise<{ ws: LocalGitWorkspace; wc: WorkingCopy }> {
    const ws = new LocalGitWorkspace({ workspaceRoot: tempDir("lgw-root-"), commitIdentity: IDENTITY });
    const result = await ws.sync([{ id: "acme/widget", source: { url: origin, branch: "main" } }]);
    return { ws, wc: result.workingCopies[0]! };
  }

  it("publishes an agent's edits as one commit on a new branch, by the configured identity, ignored files left out", async () => {
    const { origin } = makeOrigin();
    const { ws, wc } = await synced(origin);
    const prep = await ws.prepareBranch(wc, { branch: BRANCH, start: "default" });
    if (prep.kind !== "prepared") throw new Error("expected a prepared branch");
    expect(prep.prepared).toMatchObject({ branch: BRANCH, remoteHeadSha: null, preparedSha: prep.prepared.baseSha });

    writeFileSync(join(wc.path, "README.md"), "upgraded\n");
    mkdirSync(join(wc.path, "build"));
    writeFileSync(join(wc.path, "build", "out.txt"), "generated\n");
    const published = await ws.publishBranch(wc, prep.prepared, { message: "upgrading things" });

    if (published.kind !== "pushed") throw new Error("expected a push");
    expect(gitOut(origin, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(published.sha);
    expect(gitOut(origin, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s|%P", BRANCH])).toBe(
      `${IDENTITY.name} <${IDENTITY.email}>|${IDENTITY.name} <${IDENTITY.email}>|upgrading things|${prep.prepared.baseSha}`,
    );
    expect(gitOut(origin, ["show", `${BRANCH}:README.md`])).toBe("upgraded");
    expect(gitOut(origin, ["ls-tree", "-r", "--name-only", BRANCH])).not.toContain("build/out.txt");
  });

  it("updates an existing branch on top of its head with main merged in, keeping a review fix", async () => {
    const { origin, scratch } = makeOrigin();
    git(scratch, ["checkout", "-q", "-b", BRANCH]);
    commitIn(scratch, "deps.txt", "a=1\n", "first refresh");
    commitIn(scratch, "fix.txt", "review fix\n", "review fix");
    git(scratch, ["push", "-q", "origin", BRANCH]);
    git(scratch, ["checkout", "-q", "main"]);
    commitIn(scratch, "CHANGELOG.md", "main moved\n", "main moved");
    git(scratch, ["push", "-q", "origin", "main"]);
    const prHead = gitOut(scratch, ["rev-parse", BRANCH]);

    const { ws, wc } = await synced(origin);
    const prep = await ws.prepareBranch(wc, { branch: BRANCH, start: "remote-merged" });
    if (prep.kind !== "prepared") throw new Error("expected a prepared branch");
    expect(prep.prepared.remoteHeadSha).toBe(prHead);
    expect(prep.prepared.preparedSha).not.toBe(prHead);

    writeFileSync(join(wc.path, "deps.txt"), "a=2\n");
    const published = await ws.publishBranch(wc, prep.prepared, { message: "refreshing again" });

    if (published.kind !== "pushed") throw new Error("expected a push");
    expect(gitOut(origin, ["merge-base", "--is-ancestor", prHead, BRANCH]) === "").toBe(true);
    expect(gitOut(origin, ["show", `${BRANCH}:fix.txt`])).toBe("review fix");
    expect(gitOut(origin, ["show", `${BRANCH}:CHANGELOG.md`])).toBe("main moved");
    expect(gitOut(origin, ["show", `${BRANCH}:deps.txt`])).toBe("a=2");
  });

  it("reports a conflict merging main and leaves the branch at its remote head", async () => {
    const { origin, scratch } = makeOrigin();
    git(scratch, ["checkout", "-q", "-b", BRANCH]);
    commitIn(scratch, "README.md", "branch side\n", "branch edit");
    git(scratch, ["push", "-q", "origin", BRANCH]);
    git(scratch, ["checkout", "-q", "main"]);
    commitIn(scratch, "README.md", "main side\n", "main edit");
    git(scratch, ["push", "-q", "origin", "main"]);

    const { ws, wc } = await synced(origin);
    expect(await ws.prepareBranch(wc, { branch: BRANCH, start: "remote-merged" })).toEqual({ kind: "conflict" });
    expect(readFileSync(join(wc.path, "README.md"), "utf8")).toBe("branch side\n");
    expect(gitOut(wc.path, ["status", "--porcelain"])).toBe("");
  });

  it("refuses to publish when the remote branch moved since it was prepared", async () => {
    const { origin, scratch } = makeOrigin();
    git(scratch, ["checkout", "-q", "-b", BRANCH]);
    commitIn(scratch, "deps.txt", "a=1\n", "first refresh");
    git(scratch, ["push", "-q", "origin", BRANCH]);

    const { ws, wc } = await synced(origin);
    const prep = await ws.prepareBranch(wc, { branch: BRANCH, start: "remote" });
    if (prep.kind !== "prepared") throw new Error("expected a prepared branch");
    commitIn(scratch, "other.txt", "someone else\n", "concurrent push");
    git(scratch, ["push", "-q", "origin", BRANCH]);
    const moved = gitOut(scratch, ["rev-parse", "HEAD"]);

    writeFileSync(join(wc.path, "deps.txt"), "a=2\n");
    await expect(ws.publishBranch(wc, prep.prepared, { message: "adapting" })).rejects.toThrowError(/moved since it was prepared/);
    expect(gitOut(origin, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(moved);
  });

  it("deletes a remote branch only while it is still at the expected head", async () => {
    const { origin, scratch } = makeOrigin();
    git(scratch, ["checkout", "-q", "-b", BRANCH]);
    commitIn(scratch, "deps.txt", "a=1\n", "first refresh");
    git(scratch, ["push", "-q", "origin", BRANCH]);
    const checked = gitOut(scratch, ["rev-parse", "HEAD"]);
    commitIn(scratch, "other.txt", "someone else\n", "concurrent push");
    git(scratch, ["push", "-q", "origin", BRANCH]);
    const moved = gitOut(scratch, ["rev-parse", "HEAD"]);
    const { ws, wc } = await synced(origin);

    expect(await ws.deleteRemoteBranch(wc, { branch: BRANCH, expectedSha: checked })).toEqual({ kind: "moved", found: moved });
    expect(gitOut(origin, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(moved);

    expect(await ws.deleteRemoteBranch(wc, { branch: BRANCH, expectedSha: moved })).toEqual({ kind: "deleted" });
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], { cwd: origin }).status).not.toBe(0);

    expect(await ws.deleteRemoteBranch(wc, { branch: BRANCH, expectedSha: moved })).toEqual({ kind: "moved", found: null });
  });

  it("reports unchanged when the agent edited nothing", async () => {
    const { origin } = makeOrigin();
    const { ws, wc } = await synced(origin);
    const prep = await ws.prepareBranch(wc, { branch: BRANCH, start: "default" });
    if (prep.kind !== "prepared") throw new Error("expected a prepared branch");

    expect(await ws.publishBranch(wc, prep.prepared, { message: "nothing" })).toEqual({ kind: "unchanged" });
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], { cwd: origin }).status).not.toBe(0);
  });

  it("runs nothing an agent planted: a replaced .git, a hook, an fsmonitor, a filter from global config", async () => {
    const { origin } = makeOrigin();
    const { ws, wc } = await synced(origin);
    const prep = await ws.prepareBranch(wc, { branch: BRANCH, start: "default" });
    if (prep.kind !== "prepared") throw new Error("expected a prepared branch");
    const marker = join(tempDir("lgw-marker-"), "ran");

    // A hook in the trusted git dir (it can't get there through the sandbox, but hooks are off anyway).
    mkdirSync(join(wc.gitDir!, "hooks"), { recursive: true });
    writeFileSync(join(wc.gitDir!, "hooks", "pre-commit"), `#!/bin/sh\ntouch "${marker}-hook"\n`, { mode: 0o755 });
    // The agent's working tree: `.git` replaced by a directory with an fsmonitor and a hook of its own …
    rmSync(join(wc.path, ".git"));
    mkdirSync(join(wc.path, ".git", "hooks"), { recursive: true });
    writeFileSync(join(wc.path, ".git", "config"), `[core]\n\tfsmonitor = touch "${marker}-fsmonitor"\n`);
    writeFileSync(join(wc.path, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch "${marker}-agent-hook"\n`, { mode: 0o755 });
    // … and a .gitattributes naming a filter the user's global config defines.
    const home = tempDir("lgw-home-");
    writeFileSync(join(home, ".gitconfig"), `[filter "evil"]\n\tclean = touch "${marker}-filter" && cat\n`);
    process.env["HOME"] = home;
    writeFileSync(join(wc.path, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(wc.path, "README.md"), "upgraded\n");

    const published = await ws.publishBranch(wc, prep.prepared, { message: "upgrading things" });

    expect(published.kind).toBe("pushed");
    for (const suffix of ["-hook", "-fsmonitor", "-agent-hook", "-filter"]) expect(existsSync(`${marker}${suffix}`)).toBe(false);
    // The agent's `.git` directory is working-tree content to the runtime's git; it isn't committed as a repo.
    expect(gitOut(origin, ["show", `${BRANCH}:README.md`])).toBe("upgraded");
  });

  it("discards a copy in the older layout (.git inside the working copy) and clones again", async () => {
    const { origin } = makeOrigin();
    const root = tempDir("lgw-root-");
    const old = join(root, "acme__widget");
    git(root, ["clone", "-q", origin, old]);
    writeFileSync(join(old, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const result = await new LocalGitWorkspace({ workspaceRoot: root }).sync([
      { id: "acme/widget", source: { url: origin, branch: "main" } },
    ]);

    expect(result.report[0]?.outcome).toBe("cloned");
    expect(readFileSync(join(old, ".git"), "utf8")).toMatch(/^gitdir: /);
  });
});
