import { describe, expect, it } from "vitest";

import { maskGitCredentials, StderrTail, stderrSuffix } from "../src/working-copy/git-failure.ts";

const AUTH = { host: "github.com", token: "super-secret-clone-token" };
const BASIC = Buffer.from(`x-access-token:${AUTH.token}`).toString("base64");

describe("maskGitCredentials", () => {
  it("masks the token, its Basic header value, any Authorization value and URL userinfo", () => {
    const text = [
      `token ${AUTH.token} here`,
      `extra Basic ${BASIC}`,
      "Authorization: Bearer abc.def",
      "authorization:token-only",
      "fatal: unable to access 'https://someone:pa55@github.com/acme/widget.git/'",
    ].join("\n");

    const masked = maskGitCredentials(text, AUTH);

    expect(masked).toBe(
      [
        "token <redacted> here",
        "extra Basic <redacted>",
        "Authorization: <redacted>",
        "authorization:<redacted>",
        "fatal: unable to access 'https://<redacted>@github.com/acme/widget.git/'",
      ].join("\n"),
    );
  });

  it("masks an Authorization value through its line end, without taking the next line", () => {
    expect(maskGitCredentials("Authorization: Basic abc\nfatal: why", undefined)).toBe("Authorization: <redacted>\nfatal: why");
    expect(maskGitCredentials('Authorization: Digest username="x", nonce="n0nce", response="r3sp"\nnext', undefined)).toBe(
      "Authorization: <redacted>\nnext",
    );
  });

  it("masks URL userinfo through the authority's last @", () => {
    expect(maskGitCredentials("fetching https://x:abc@def@github.com/a/b failed", undefined)).toBe(
      "fetching https://<redacted>@github.com/a/b failed",
    );
    expect(maskGitCredentials("see https://github.com/a/b and mail@example.com", undefined)).toBe(
      "see https://github.com/a/b and mail@example.com",
    );
  });

  it("leaves text without credentials alone", () => {
    const text = "fatal: couldn't find remote ref refs/heads/bump-it/missing";
    expect(maskGitCredentials(text, AUTH)).toBe(text);
  });
});

describe("StderrTail", () => {
  it("keeps short output whole, across chunks", () => {
    const tail = new StderrTail();
    tail.append("fatal: unable");
    tail.append(" to access\n");
    expect(tail.text()).toBe("fatal: unable to access\n");
  });

  it.each([
    ["the raw token", AUTH.token],
    ["its Basic value", BASIC],
  ])("drops the partial line a truncation leaves inside %s, so no fragment survives", (_name, secret) => {
    const window = 64 * 1024;
    const reason = "\nfatal: the reason\n";
    // Sized so the retained window starts halfway through the secret.
    const padding = window - Math.ceil(secret.length / 2) - 1 - reason.length;
    const text = `${"x".repeat(10)}${secret}\n${"y".repeat(padding)}${reason}`;
    const cutHalf = secret.slice(Math.floor(secret.length / 2));
    expect(text.slice(text.length - window).startsWith(cutHalf)).toBe(true);
    const tail = new StderrTail();
    for (let i = 0; i < text.length; i += 1000) tail.append(text.slice(i, i + 1000));

    const kept = tail.text();

    expect(kept.endsWith("fatal: the reason\n")).toBe(true);
    expect(kept).not.toContain(cutHalf);
    expect(kept.length).toBeLessThanOrEqual(window);
  });

  it("keeps nothing when the whole window is one cut line", () => {
    const tail = new StderrTail();
    tail.append("z".repeat(70 * 1024));
    expect(tail.text()).toBe("");
  });
});

describe("stderrSuffix", () => {
  it("says nothing when git said nothing", () => {
    expect(stderrSuffix(" \n", AUTH)).toBe("");
  });

  it("quotes the masked end of a long stderr", () => {
    const suffix = stderrSuffix(`${"w".repeat(5000)}\nfatal: token ${AUTH.token} refused`, AUTH);

    expect(suffix.startsWith("; stderr: …")).toBe(true);
    expect(suffix.endsWith("fatal: token <redacted> refused")).toBe(true);
    expect(suffix.length).toBeLessThanOrEqual("; stderr: …".length + 2000);
  });
});
