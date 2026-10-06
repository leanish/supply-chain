// Copied from leanish/leanish-development core/runtime/test/unit/codex-runner-access.test.ts at e4f8a1e; see PROVENANCE.md.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CodexLoginKeptError } from "../src/skill/codex-login.ts";
import { CodexRunner } from "../src/skill/codex-runner.ts";
import { SkillLoader } from "../src/skill/skill-loader.ts";
import type { LoadedSkill } from "../src/skill/skill.ts";
import type { WorkingCopy } from "../src/types/working-copy.ts";

const ASK_FILE = `---
name: ask
description: Test
inputSchema: { type: object }
outputSchema: { type: object }
---

# ask
`;

const ANSWER = `cat <<'EOF'
\`\`\`json
{"answer": "ok"}
\`\`\`
EOF
`;

let askSkill: LoadedSkill;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-access-skill-"));
  await mkdir(join(dir, "ask"), { recursive: true });
  await writeFile(join(dir, "ask", "SKILL.md"), ASK_FILE);
  askSkill = await new SkillLoader({ skillsDirs: [dir] }).loadEntrypoint("ask");
});

interface Stub {
  readonly bin: string;
  /** `CODEX_HOME=` and one `ARG=` line per argument. */
  readonly recordFile: string;
  /** Free for the stub's `body` to write to. */
  readonly sideFile: string;
}

/**
 * Stub `codex` that records its home and arguments, runs `body`, then answers.
 * Its `app-server` (the runner's quota reading) exits at once, unanswered.
 */
async function stubCodex(body: (sideFile: string) => string = () => ""): Promise<Stub> {
  const dir = await mkdtemp(join(tmpdir(), "codex-access-bin-"));
  const recordFile = join(dir, "record.txt");
  const sideFile = join(dir, "side.txt");
  const bin = join(dir, "codex");
  await writeFile(
    bin,
    `#!/bin/sh
[ "$1" = app-server ] && exit 1
echo "CODEX_HOME=$CODEX_HOME" > "${recordFile}"
for arg in "$@"; do echo "ARG=$arg" >> "${recordFile}"; done
${body(sideFile)}
${ANSWER}`,
  );
  await chmod(bin, 0o755);
  return { bin, recordFile, sideFile };
}

async function recordedArgs(recordFile: string): Promise<string[]> {
  const record = await readFile(recordFile, "utf8");
  return record
    .split("\n")
    .filter((line) => line.startsWith("ARG="))
    .map((line) => line.slice("ARG=".length));
}

/** A working copy laid out like `LocalGitWorkspace`'s: git metadata in a separate directory. */
async function separateClone(name: string): Promise<WorkingCopy & { readonly gitDir: string }> {
  const path = await mkdtemp(join(tmpdir(), `codex-access-${name}-`));
  const gitDir = await mkdtemp(join(tmpdir(), `codex-access-${name}-git-`));
  await writeFile(join(path, ".git"), `gitdir: ${gitDir}\n`);
  return { projectId: name, path, branch: "main", headSha: "0".repeat(40), gitDir };
}

function invocation(workingCopies: ReadonlyArray<WorkingCopy>, access?: "read-only" | "write") {
  return {
    entrypoint: askSkill,
    supportSkills: [],
    renderedArguments: "x: 1",
    workingCopies,
    ...(access !== undefined ? { access } : {}),
  };
}

describe("CodexRunner sandbox", () => {
  /** The value of each `-c key=value` pair, by key. */
  function configValues(args: ReadonlyArray<string>): Map<string, string> {
    const values = new Map<string, string>();
    args.forEach((arg, i) => {
      if (args[i - 1] !== "-c") return;
      const eq = arg.indexOf("=");
      values.set(arg.slice(0, eq), arg.slice(eq + 1));
    });
    return values;
  }

  async function codexHomeOf(recordFile: string): Promise<string> {
    return /CODEX_HOME=(.+)/.exec(await readFile(recordFile, "utf8"))?.[1] ?? "";
  }

  it("runs read-only by default: a permission profile with no writes, no network and approvals off", async () => {
    const { bin, recordFile } = await stubCodex();
    await new CodexRunner({ bin, suppressFlags: [] }).run(invocation([]));

    const args = await recordedArgs(recordFile);
    const home = await codexHomeOf(recordFile);
    const config = configValues(args);
    expect(config.get("default_permissions")).toBe('"agent-runtime"');
    expect(config.get("permissions.agent-runtime.filesystem")).toBe(
      `{":root"="read", ":workspace_roots"={"."="read"}, ${JSON.stringify(join(home, "auth.json"))}="deny"}`,
    );
    expect(config.get("permissions.agent-runtime.network.enabled")).toBe("false");
    expect(config.get("approval_policy")).toBe('"never"');
    // The older sandbox settings don't compose with profiles, so none may appear.
    expect(args.join(" ")).not.toMatch(/--sandbox|sandbox_mode|sandbox_workspace_write/);
  });

  it("lets a write run write its working copies, the temp dirs and the extra roots, with network, but not their git metadata", async () => {
    const first = await separateClone("first");
    const second = await separateClone("second");
    const extraRoot = await mkdtemp(join(tmpdir(), "codex-access-extra-"));
    const cacheRoot = join(await mkdtemp(join(tmpdir(), "codex-access-cache-")), "not-yet-created");
    const { bin, recordFile } = await stubCodex();
    await new CodexRunner({ bin, suppressFlags: [], writableRoots: [extraRoot], buildCacheRoot: cacheRoot }).run(
      invocation([first, second], "write"),
    );

    const home = await codexHomeOf(recordFile);
    const config = configValues(await recordedArgs(recordFile));
    expect(config.get("permissions.agent-runtime.filesystem")).toBe(
      `{":root"="read", ":workspace_roots"={"."="write"}, ":tmpdir"="write", ":slash_tmp"="write", ` +
        `${JSON.stringify(extraRoot)}="write", ${JSON.stringify(cacheRoot)}="write", ` +
        `${JSON.stringify(first.gitDir)}="read", ${JSON.stringify(second.gitDir)}="read", ` +
        `${JSON.stringify(join(home, "auth.json"))}="deny"}`,
    );
    expect(config.get("permissions.agent-runtime.network.enabled")).toBe("true");
    expect((await stat(cacheRoot)).isDirectory()).toBe(true);
  });

  it("adds the read rules to both access levels", async () => {
    const { bin, recordFile } = await stubCodex();
    const runner = new CodexRunner({ bin, suppressFlags: [], readDenied: ["/home/dev"], readAllowed: ["/home/dev/.nvm"] });

    for (const access of ["read-only", "write"] as const) {
      await runner.run(invocation(access === "write" ? [await separateClone("rules")] : [], access));
      expect(configValues(await recordedArgs(recordFile)).get("permissions.agent-runtime.filesystem")).toContain(
        '"/home/dev"="deny", "/home/dev/.nvm"="read"',
      );
    }
  });

  it("refuses a working copy inside a read-denied path, before spawning", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-access-home-"));
    const inside = { projectId: "wc", path: join(home, "repos/wc"), branch: "main", headSha: "0".repeat(40) };
    const { bin, recordFile } = await stubCodex();
    const runner = new CodexRunner({ bin, readDenied: [home] });

    for (const access of ["read-only", "write"] as const) {
      await expect(runner.run(invocation([inside], access))).rejects.toThrowError(
        /working copy .* is inside the read-denied/,
      );
    }
    await expect(readFile(recordFile, "utf8")).rejects.toThrowError(/ENOENT/);
  });

  it("routes the build caches after the invocation env, so target credentials can't redirect them", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-access-cache-"));
    const { bin, sideFile } = await stubCodex((side) => `echo "$GRADLE_USER_HOME $npm_config_cache" > "${side}"`);
    await new CodexRunner({ bin, suppressFlags: [], buildCacheRoot: cacheRoot }).run({
      ...invocation([]),
      env: { GRADLE_USER_HOME: "/elsewhere", npm_config_cache: "/elsewhere" },
    });

    expect((await readFile(sideFile, "utf8")).trim()).toBe(`${join(cacheRoot, "gradle")} ${join(cacheRoot, "npm")}`);
  });

  it("keeps ambient credentials from the CLI; only the target credentials and Codex's own key reach it", async () => {
    const ambient = {
      GH_TOKEN: "ambient-gh",
      GITHUB_TOKEN: "ambient-github",
      NODE_AUTH_TOKEN: "ambient-npm",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      MY_SECRET: "ambient-secret",
      CODEX_API_KEY: "codex-key",
      KEPT_VAR: "kept",
    };
    const saved = Object.fromEntries(Object.keys(ambient).map((name) => [name, process.env[name]]));
    Object.assign(process.env, ambient);
    try {
      const names = Object.keys(ambient);
      const { bin, sideFile } = await stubCodex((side) => names.map((name) => `echo "${name}=[$${name}]" >> "${side}"`).join("\n"));
      await new CodexRunner({ bin, suppressFlags: [] }).run({
        ...invocation([]),
        env: { GITHUB_TOKEN: "target-token" },
      });
      expect((await readFile(sideFile, "utf8")).trim().split("\n")).toEqual([
        "GH_TOKEN=[]",
        "GITHUB_TOKEN=[target-token]",
        "NODE_AUTH_TOKEN=[]",
        "SSH_AUTH_SOCK=[]",
        "MY_SECRET=[]",
        "CODEX_API_KEY=[codex-key]",
        "KEPT_VAR=[kept]",
      ]);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("lets the commands Codex runs see the CLI's env minus Codex's own API keys", async () => {
    const saved = process.env["CODEX_API_KEY"];
    process.env["CODEX_API_KEY"] = "codex-key";
    try {
      const { bin, recordFile } = await stubCodex();
      await new CodexRunner({ bin, suppressFlags: [], env: { RUNNER_VAR: "x" } }).run({
        ...invocation([]),
        env: { GH_TOKEN: "target-token" },
      });

      const args = await recordedArgs(recordFile);
      expect(args).toContain("shell_environment_policy.ignore_default_excludes=true");
      const includeOnly = args.find((arg) => arg.startsWith("shell_environment_policy.include_only="));
      const names = JSON.parse(includeOnly!.slice("shell_environment_policy.include_only=".length)) as string[];
      expect(names).toEqual(expect.arrayContaining(["GH_TOKEN", "RUNNER_VAR", "PATH", "CODEX_HOME", "GIT_ASKPASS"]));
      expect(names).not.toContain("CODEX_API_KEY");
      // Never a value: only names reach the command line.
      expect(args.join(" ")).not.toContain("target-token");
    } finally {
      if (saved === undefined) delete process.env["CODEX_API_KEY"];
      else process.env["CODEX_API_KEY"] = saved;
    }
  });

  it("gives git a GH_TOKEN through GIT_ASKPASS, and gh an empty config dir", async () => {
    const { bin, sideFile } = await stubCodex(
      (side) =>
        `{ "$GIT_ASKPASS" "Username for 'https://github.com': "; "$GIT_ASKPASS" "Password for 'https://x-access-token@github.com': "; ` +
        `echo "GH_CONFIG_DIR=$GH_CONFIG_DIR"; ls -A "$GH_CONFIG_DIR" | wc -l | tr -d ' '; echo "PROMPT=$GIT_TERMINAL_PROMPT"; } > "${side}"`,
    );
    await new CodexRunner({ bin, suppressFlags: [] }).run({ ...invocation([]), env: { GH_TOKEN: "target-token" } });

    const [user, password, configDir, entries, prompt] = (await readFile(sideFile, "utf8")).trim().split("\n");
    expect(user).toBe("x-access-token");
    expect(password).toBe("target-token");
    expect(configDir).toMatch(/^GH_CONFIG_DIR=.+\/gh$/);
    expect(entries).toBe("0");
    expect(prompt).toBe("PROMPT=0");
  });

  it("sets no git askpass without a GH_TOKEN", async () => {
    const { bin, sideFile } = await stubCodex((side) => `echo "[$GIT_ASKPASS][$GH_CONFIG_DIR]" > "${side}"`);
    await new CodexRunner({ bin, suppressFlags: [] }).run(invocation([]));
    expect((await readFile(sideFile, "utf8")).trim()).toBe("[][]");
  });

  it("keeps the user's shell startup files out: an empty ZDOTDIR and no BASH_ENV", async () => {
    const { bin, sideFile } = await stubCodex(
      (side) => `{ echo "ZDOTDIR=$ZDOTDIR"; ls -A "$ZDOTDIR" | wc -l | tr -d ' '; echo "BASH_ENV=[$BASH_ENV]"; } > "${side}"`,
    );
    await new CodexRunner({ bin, suppressFlags: [], env: { BASH_ENV: "/home/dev/.bashrc" } }).run({
      ...invocation([]),
      env: { ZDOTDIR: "/home/dev" },
    });

    const [zdotdir, entries, bashEnv] = (await readFile(sideFile, "utf8")).trim().split("\n");
    expect(zdotdir).toMatch(/^ZDOTDIR=.*agent-runtime-skill-.*\/zdotdir$/);
    expect(entries).toBe("0");
    expect(bashEnv).toBe("BASH_ENV=[]");
  });

  it("creates the writable roots only for write runs", async () => {
    const cacheRoot = join(await mkdtemp(join(tmpdir(), "codex-access-cache-")), "lazy");
    const { bin } = await stubCodex();
    await new CodexRunner({ bin, suppressFlags: [], buildCacheRoot: cacheRoot }).run(invocation([]));

    await expect(stat(cacheRoot)).rejects.toThrowError(/ENOENT/);
  });

  it("rejects read and write rules that can't mean what they say, at construction", () => {
    expect(() => new CodexRunner({ readDenied: ["relative/dir"] })).toThrowError(/must be absolute/);
    expect(() => new CodexRunner({ writableRoots: ["cache"] })).toThrowError(/must be absolute/);
    expect(() => new CodexRunner({ readDenied: ["/home/dev"], readAllowed: ["/home/dev"] })).toThrowError(
      /both in readDenied and readAllowed/,
    );
    expect(() => new CodexRunner({ readDenied: ["/home/dev"], readAllowed: ["/opt/tools"] })).toThrowError(
      /isn't inside any readDenied path/,
    );
    expect(() => new CodexRunner({ readDenied: ["/home/dev"], buildCacheRoot: "/home/dev/.cache/agent" })).toThrowError(
      /writable root \/home\/dev\/.cache\/agent is inside the read-denied \/home\/dev/,
    );
  });

  it("refuses write access without a working copy, before spawning", async () => {
    const { bin, recordFile } = await stubCodex();
    await expect(new CodexRunner({ bin }).run(invocation([], "write"))).rejects.toThrowError(
      /access 'write' needs at least one working copy/,
    );
    await expect(readFile(recordFile, "utf8")).rejects.toThrowError(/ENOENT/);
  });

  it("refuses write access to a working copy without separate git metadata, before spawning", async () => {
    const { bin, recordFile } = await stubCodex();
    const runner = new CodexRunner({ bin });

    const missing = await separateClone("missing");
    const { gitDir: _unused, ...withoutGitDir } = missing;
    await expect(runner.run(invocation([withoutGitDir], "write"))).rejects.toThrowError(/git metadata in a separate directory/);

    const inside = await separateClone("inside");
    await mkdir(join(inside.path, "meta"));
    await expect(runner.run(invocation([{ ...inside, gitDir: join(inside.path, "meta") }], "write"))).rejects.toThrowError(
      /must live outside the working tree/,
    );

    const linked = await separateClone("linked");
    const link = join(await mkdtemp(join(tmpdir(), "codex-access-link-")), "git");
    await symlink(linked.gitDir, link);
    await expect(runner.run(invocation([{ ...linked, gitDir: link }], "write"))).rejects.toThrowError(
      /git metadata in a separate directory/,
    );
    await expect(readFile(recordFile, "utf8")).rejects.toThrowError(/ENOENT/);
  });
});

describe("CodexRunner login reuse", () => {
  const savedApiKey = process.env["CODEX_API_KEY"];
  afterEach(() => {
    if (savedApiKey === undefined) delete process.env["CODEX_API_KEY"];
    else process.env["CODEX_API_KEY"] = savedApiKey;
  });

  async function loginHomeWith(content: string | undefined): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "codex-access-login-"));
    if (content !== undefined) await writeFile(join(home, "auth.json"), content, { mode: 0o600 });
    return home;
  }

  const REPLACE_LOGIN = `rm "$CODEX_HOME/auth.json"; printf '{"token":"refreshed"}' > "$CODEX_HOME/auth.json"`;

  async function savedLogins(loginHome: string): Promise<string[]> {
    return (await readdir(loginHome)).filter((name) => name.startsWith("auth.json.agent-runtime-"));
  }

  it("links the login file into the staged home and removes the staged home afterwards", async () => {
    const loginHome = await loginHomeWith('{"token":"original"}');
    const { bin, recordFile, sideFile } = await stubCodex(
      (side) => `echo "LINK=$(readlink "$CODEX_HOME/auth.json")" >> "${side}"; cat "$CODEX_HOME/auth.json" >> "${side}"`,
    );
    await new CodexRunner({ bin, suppressFlags: [], loginHome }).run(invocation([]));

    const sideRecord = await readFile(sideFile, "utf8");
    expect(sideRecord).toContain(`LINK=${join(loginHome, "auth.json")}`);
    expect(sideRecord).toContain('{"token":"original"}');
    const codexHome = /CODEX_HOME=(.+)/.exec(await readFile(recordFile, "utf8"))?.[1] ?? "";
    await expect(stat(codexHome)).rejects.toThrowError(/ENOENT/);
  });

  it("resolves a relative login home against the process's cwd, not the staged home", async () => {
    // Under the cwd, so the relative path can't happen to resolve from the staged home too.
    const loginHome = await mkdtemp(join(process.cwd(), ".codex-login-test-"));
    try {
      await writeFile(join(loginHome, "auth.json"), '{"token":"original"}', { mode: 0o600 });
      const { bin, sideFile } = await stubCodex((side) => `cat "$CODEX_HOME/auth.json" > "${side}"`);
      await new CodexRunner({ bin, suppressFlags: [], loginHome: relative(process.cwd(), loginHome) }).run(
        invocation([]),
      );

      expect(await readFile(sideFile, "utf8")).toBe('{"token":"original"}');
    } finally {
      await rm(loginHome, { recursive: true });
    }
  });

  it("fails before staging when there's neither a login file nor CODEX_API_KEY", async () => {
    delete process.env["CODEX_API_KEY"];
    const loginHome = await loginHomeWith(undefined);
    const { bin, recordFile } = await stubCodex();

    await expect(new CodexRunner({ bin, loginHome }).run(invocation([]))).rejects.toThrowError(
      /no file-backed Codex login under .*run `codex login` or set CODEX_API_KEY/,
    );
    await expect(readFile(recordFile, "utf8")).rejects.toThrowError(/ENOENT/);
  });

  it("runs on CODEX_API_KEY when there's no login file, linking nothing", async () => {
    delete process.env["CODEX_API_KEY"];
    const loginHome = await loginHomeWith(undefined);
    const { bin, sideFile } = await stubCodex((side) => `[ -e "$CODEX_HOME/auth.json" ] && echo "HAS_AUTH" > "${side}"; true`);

    await new CodexRunner({ bin, suppressFlags: [], loginHome, env: { CODEX_API_KEY: "test-key" } }).run(
      invocation([]),
    );
    await expect(readFile(sideFile, "utf8")).rejects.toThrowError(/ENOENT/);
  });

  it("saves a login Codex replaced next to the real one and fails, leaving the real file as is", async () => {
    const loginHome = await loginHomeWith('{"token":"original"}');
    const { bin } = await stubCodex(() => REPLACE_LOGIN);

    await expect(new CodexRunner({ bin, suppressFlags: [], loginHome }).run(invocation([]))).rejects.toThrowError(
      /replaced the linked login.*saved to .*auth\.json\.agent-runtime-.*left as is/,
    );
    expect(await readFile(join(loginHome, "auth.json"), "utf8")).toBe('{"token":"original"}');
    const [saved, ...others] = await savedLogins(loginHome);
    expect(others).toEqual([]);
    expect(await readFile(join(loginHome, saved!), "utf8")).toBe('{"token":"refreshed"}');
    expect((await stat(join(loginHome, saved!))).mode & 0o777).toBe(0o600);
  });

  it("keeps the run's own failure as the cause", async () => {
    const loginHome = await loginHomeWith('{"token":"original"}');
    const { bin } = await stubCodex(() => `${REPLACE_LOGIN}; exit 3`);

    const error = await new CodexRunner({ bin, suppressFlags: [], loginHome }).run(invocation([])).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/replaced the linked login/);
    expect(((error as Error).cause as Error).message).toMatch(/exited with code 3/);
  });

  it("checks the login after a timeout, once Codex has exited", async () => {
    const loginHome = await loginHomeWith('{"token":"original"}');
    const { bin } = await stubCodex(() => `${REPLACE_LOGIN}; sleep 5`);

    const error = await new CodexRunner({ bin, suppressFlags: [], loginHome, timeoutMs: 1000 })
      .run(invocation([]))
      .catch((err) => err);
    expect((error as Error).message).toMatch(/replaced the linked login/);
    expect(((error as Error).cause as Error).message).toMatch(/did not return within \d+ms/);
    expect(await savedLogins(loginHome)).toHaveLength(1);
  });

  it("keeps the staged home when the replaced login can't be saved", async () => {
    const loginHome = await loginHomeWith('{"token":"original"}');
    const { bin, recordFile } = await stubCodex(() => REPLACE_LOGIN);
    await chmod(loginHome, 0o500);
    try {
      const error = await new CodexRunner({ bin, suppressFlags: [], loginHome }).run(invocation([])).catch((err) => err);
      expect(error).toBeInstanceOf(CodexLoginKeptError);
      const codexHome = /CODEX_HOME=(.+)/.exec(await readFile(recordFile, "utf8"))?.[1] ?? "";
      expect((error as Error).message).toContain(join(codexHome, "auth.json"));
      expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe('{"token":"refreshed"}');
    } finally {
      await chmod(loginHome, 0o700);
    }
  });
});

