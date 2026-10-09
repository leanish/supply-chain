/**
 * npm marks every `bin` target executable on install; one committed without
 * the bit shows up as a change in a tool's own working copy. Read the mode git
 * records: `npm ci` fixes the working tree's before the tests run.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url).pathname;

describe("bin targets", () => {
  const bins = readdirSync(join(ROOT, "packages")).flatMap((dir) => {
    let manifest: { bin?: Record<string, string> };
    try {
      manifest = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")) as { bin?: Record<string, string> };
    } catch {
      return [];
    }
    return Object.values(manifest.bin ?? {}).map((target) => join("packages", dir, target));
  });

  it("are found", () => {
    expect(bins.length).toBeGreaterThan(0);
  });

  it.each(bins)("%s is committed executable, as npm would make it", (path) => {
    const entry = execFileSync("git", ["ls-files", "--stage", "--", path], { cwd: ROOT, encoding: "utf8" });
    expect(entry.split(" ")[0]).toBe("100755");
  });
});
