// Copied from leanish/leanish-development core/runtime/test/unit/codex-permissions.test.ts at e4f8a1e; see PROVENANCE.md.
import { describe, expect, it } from "vitest";

import {
  codexPermissionArgs,
  assertOutsideDenied,
  isInsidePath,
  validateReadRules,
} from "../src/skill/codex-permissions.ts";

describe("codexPermissionArgs", () => {
  it("escapes paths into valid TOML basic strings", () => {
    const args = codexPermissionArgs({
      access: "read-only",
      gitDirs: [],
      stagedHome: "/tmp/staged",
      writableRoots: [],
      readDenied: ['/home/dev/odd "dir"\\x'],
      readAllowed: [],
    });
    expect(args).toContain(
      'permissions.agent-runtime.filesystem={":root"="read", ":workspace_roots"={"."="read"}, ' +
        '"/home/dev/odd \\"dir\\"\\\\x"="deny", "/tmp/staged/auth.json"="deny"}',
    );
  });

  it("ignores write-only inputs on a read-only run", () => {
    const args = codexPermissionArgs({
      access: "read-only",
      gitDirs: ["/wc/.git"],
      stagedHome: "/tmp/staged",
      writableRoots: ["/cache"],
      readDenied: [],
      readAllowed: [],
    });
    expect(args.join(" ")).not.toMatch(/\/wc\/\.git|\/cache|:tmpdir/);
  });
});

describe("assertOutsideDenied", () => {
  it("accepts paths outside every denied root", () => {
    expect(() => assertOutsideDenied(["/var/tmp/wc"], ["/home/dev"], "working copy")).not.toThrow();
  });

  it("rejects a path inside or equal to a denied root, naming both", () => {
    expect(() => assertOutsideDenied(["/home/dev/repos/wc"], ["/home/dev"], "working copy")).toThrowError(
      "CodexRunner: working copy /home/dev/repos/wc is inside the read-denied /home/dev; tools can't resolve paths under a denied directory — move it outside",
    );
    expect(() => assertOutsideDenied(["/home/dev"], ["/home/dev"], "writable root")).toThrowError(/inside the read-denied/);
  });
});

describe("validateReadRules", () => {
  it("accepts exceptions strictly inside a denied path", () => {
    expect(() => validateReadRules(["/home/dev"], ["/home/dev/.nvm"])).not.toThrow();
  });

  it("rejects a sibling that only shares a prefix", () => {
    expect(() => validateReadRules(["/home/dev"], ["/home/dev2/tools"])).toThrowError(/isn't inside/);
  });
});

describe("isInsidePath", () => {
  it("is strict and component-wise", () => {
    expect(isInsidePath("/a/b", "/a")).toBe(true);
    expect(isInsidePath("/a", "/a")).toBe(false);
    expect(isInsidePath("/ab", "/a")).toBe(false);
    expect(isInsidePath("/a/..b", "/a")).toBe(true);
  });
});
