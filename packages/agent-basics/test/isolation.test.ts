// New in this repository.
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { codexIsolation, type IsolationSettings } from "../src/isolation.ts";
import { KeychainStore } from "../src/secret-store.ts";

const SETTINGS: IsolationSettings = {
  commitIdentity: { name: "secure-it", email: "secure-it@example.com" },
  readDeny: ["/Users/dev/private-data"],
  commandPath: ["/opt/tool/guard"],
  releaseAgeDays: 7,
  buildCacheRoot: "/Users/dev/.cache/leanish/secure-it",
};
const HOME = "/Users/dev";

describe("codexIsolation", () => {
  it("denies the sensitive home paths that exist and the configured ones, and gives the agent the configured identity", () => {
    const existing = new Set([`${HOME}/.ssh`, `${HOME}/.gitconfig`, `${HOME}/Library/Keychains`]);
    const options = codexIsolation(SETTINGS, { home: HOME, env: { PATH: "/usr/bin:/bin" }, exists: (path) => existing.has(path) });
    expect(options.readDenied).toEqual([
      `${HOME}/.ssh`,
      `${HOME}/.gitconfig`,
      `${HOME}/Library/Keychains`,
      "/Users/dev/private-data",
      `${HOME}/.codex/auth.json`,
    ]);
    expect(options.loginHome).toBe(`${HOME}/.codex`);
    expect(options.buildCacheRoot).toBe(SETTINGS.buildCacheRoot);
    expect(options.env).toEqual({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "/dev/null",
      npm_config_userconfig: "/dev/null",
      npm_config_ignore_scripts: "true",
      npm_config_min_release_age: "7",
      PATH: "/opt/tool/guard:/usr/bin:/bin",
      GIT_AUTHOR_NAME: "secure-it",
      GIT_AUTHOR_EMAIL: "secure-it@example.com",
      GIT_COMMITTER_NAME: "secure-it",
      GIT_COMMITTER_EMAIL: "secure-it@example.com",
    });
  });

  it("reuses $CODEX_HOME's login and the repository's release age", () => {
    const options = codexIsolation({ ...SETTINGS, releaseAgeDays: 3, commandPath: [] }, { home: HOME, env: { CODEX_HOME: "/opt/codex" }, exists: () => false });
    expect(options.loginHome).toBe("/opt/codex");
    expect(options.readDenied).toContain("/opt/codex/auth.json");
    expect(options.env?.["npm_config_min_release_age"]).toBe("3");
    expect(options.env?.["PATH"]).toBeUndefined();
  });

  it("denies the resolved login file when CODEX_HOME is relative", () => {
    const options = codexIsolation(SETTINGS, {
      home: HOME,
      env: { CODEX_HOME: "custom-codex-home" },
      exists: () => false,
    });

    expect(options.readDenied).toContain(resolve("custom-codex-home", "auth.json"));
  });

  it("denies a custom login symlink and its canonical target without reading either", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-isolation-"));
    try {
      const loginHome = join(fixtureRoot, "custom-codex-home");
      const targetAuth = join(fixtureRoot, "auth-fixture.json");
      await mkdir(loginHome);
      await writeFile(targetAuth, "test fixture only");
      await symlink(targetAuth, join(loginHome, "auth.json"));
      const canonicalAuth = await realpath(targetAuth);

      const options = codexIsolation(SETTINGS, {
        home: HOME,
        env: { CODEX_HOME: loginHome },
      });

      expect(options.loginHome).toBe(loginHome);
      expect(options.readDenied).toContain(join(loginHome, "auth.json"));
      expect(options.readDenied).toContain(canonicalAuth);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("refuses relative paths and a negative or fractional release age", () => {
    const machine = { home: HOME, env: {}, exists: () => false };
    expect(() => codexIsolation({ ...SETTINGS, readDeny: ["private"] }, machine)).toThrow("must be absolute; got 'private'");
    expect(() => codexIsolation({ ...SETTINGS, commandPath: ["guard"] }, machine)).toThrow("got 'guard'");
    expect(() => codexIsolation({ ...SETTINGS, releaseAgeDays: -1 }, machine)).toThrow("non-negative integer");
    expect(() => codexIsolation({ ...SETTINGS, releaseAgeDays: 1.5 }, machine)).toThrow("non-negative integer");
  });
});

describe("KeychainStore", () => {
  it("reads a generic password by service name, without its trailing newline", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const store = new KeychainStore(async (args) => {
      calls.push(args);
      return { code: 0, stdout: "s3cret\n" };
    });
    expect(await store.get("secure-it-github")).toBe("s3cret");
    expect(calls).toEqual([["find-generic-password", "-s", "secure-it-github", "-w"]]);
  });

  it("fails on a missing or empty item, never echoing what security printed", async () => {
    const missing = new KeychainStore(async () => ({ code: 44, stdout: "leaked?" }));
    await expect(missing.get("secure-it-github")).rejects.toThrow("no Keychain item for service 'secure-it-github' (security exited 44)");
    await expect(missing.get("secure-it-github")).rejects.not.toThrow("leaked");
    const empty = new KeychainStore(async () => ({ code: 0, stdout: "\n" }));
    await expect(empty.get("secure-it-github")).rejects.toThrow("is empty");
  });

  it("refuses a service name that isn't a plain identifier", async () => {
    const store = new KeychainStore(async () => ({ code: 0, stdout: "x" }));
    await expect(store.get("-s other")).rejects.toThrow("Keychain service names are");
  });
});
