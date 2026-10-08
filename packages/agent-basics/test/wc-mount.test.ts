// Copied from leanish/leanish-development core/runtime/test/unit/wc-mount.test.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import { resolveWorkingCopyMount } from "../src/skill/wc-mount.ts";

describe("resolveWorkingCopyMount", () => {
  it("returns process.cwd() with no add-dirs when there are no working copies", () => {
    const mount = resolveWorkingCopyMount([]);
    expect(mount.cwd).toBe(process.cwd());
    expect(mount.addDirs).toEqual([]);
  });

  it("uses the first working copy as cwd; everything else as add-dirs", () => {
    const wcs = [
      { projectId: "leanish/atc", path: "/tmp/atc", branch: "main", headSha: "0".repeat(40) },
      { projectId: "leanish/utils", path: "/tmp/utils", branch: "main", headSha: "0".repeat(40) },
      { projectId: "leanish/runtime", path: "/tmp/runtime", branch: "main", headSha: "0".repeat(40) },
    ] as const;
    const mount = resolveWorkingCopyMount(wcs);
    expect(mount.cwd).toBe("/tmp/atc");
    expect(mount.addDirs).toEqual(["/tmp/utils", "/tmp/runtime"]);
  });

  it("preserves order of supplied working copies", () => {
    const wcs = [
      { projectId: "a", path: "/a", branch: "main", headSha: "0".repeat(40) },
      { projectId: "b", path: "/b", branch: "main", headSha: "0".repeat(40) },
    ] as const;
    const mount = resolveWorkingCopyMount(wcs);
    expect(mount.cwd).toBe("/a");
    expect(mount.addDirs).toEqual(["/b"]);
  });
});
