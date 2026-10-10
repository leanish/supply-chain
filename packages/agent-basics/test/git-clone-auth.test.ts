// Copied from leanish/leanish-development core/runtime/test/unit/git-clone-auth.test.ts at c6282df; see PROVENANCE.md.
// Local changes: `gitCloneAuth` tests replace the `resolveGitCloneAuth` ones; imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import { cloneAuthArgs, gitCloneAuth } from "../src/working-copy/git-clone-auth.ts";

const TOKEN = "ghp_test_token_123";
// URL-scoped to the host (not a global http.extraheader), so git only sends it
// to https://<host>/… — see cloneAuthArgs.
const scopedHeaderFor = (host: string, token: string): string =>
  `http.https://${host}/.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

describe("gitCloneAuth", () => {
  it("is github.com unless the config names another host", () => {
    expect(gitCloneAuth(TOKEN)).toEqual({ host: "github.com", token: TOKEN });
    expect(gitCloneAuth(TOKEN, "ghe.example.com")).toEqual({ host: "ghe.example.com", token: TOKEN });
  });

  it("refuses an empty token or host", () => {
    expect(() => gitCloneAuth("")).toThrow("token can't be empty");
    expect(() => gitCloneAuth(TOKEN, "")).toThrow("host can't be empty");
  });
});

describe("cloneAuthArgs", () => {
  const auth = { host: "github.com", token: TOKEN } as const;

  it("returns no args when auth is undefined", () => {
    expect(cloneAuthArgs(undefined, "https://github.com/leanish/foo.git")).toEqual([]);
  });

  it("injects a one-shot, host-scoped extraheader for an https url on the matching host", () => {
    expect(cloneAuthArgs(auth, "https://github.com/leanish/foo.git")).toEqual([
      "-c",
      scopedHeaderFor("github.com", TOKEN),
    ]);
  });

  it("does not attach the token to a different host", () => {
    expect(cloneAuthArgs(auth, "https://gitlab.com/leanish/foo.git")).toEqual([]);
  });

  it("does not attach the token to a non-https (ssh) url", () => {
    expect(cloneAuthArgs(auth, "git@github.com:leanish/foo.git")).toEqual([]);
  });

  it("does not attach the token over plain http", () => {
    expect(cloneAuthArgs(auth, "http://github.com/leanish/foo.git")).toEqual([]);
  });

  it("returns no args for a malformed url", () => {
    expect(cloneAuthArgs(auth, "not a url")).toEqual([]);
  });
});
