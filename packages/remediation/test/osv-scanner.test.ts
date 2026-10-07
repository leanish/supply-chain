import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureOsvScanner, osvPlatform } from "../src/osv-scanner.ts";

let cache: string;

beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "osv-cache-"));
});

afterAll(async () => {
  if (cache !== undefined) await rm(cache, { recursive: true, force: true });
});

describe("ensureOsvScanner", () => {
  it("knows the pinned platforms only", () => {
    expect(osvPlatform("darwin", "arm64")).toBe("darwin_arm64");
    expect(osvPlatform("linux", "x64")).toBe("linux_amd64");
    expect(osvPlatform("win32", "x64")).toBeUndefined();
  });

  it("installs when the binary is missing or swapped, and refuses an install that doesn't match", async () => {
    const calls: string[] = [];
    const binaryDir = join(cache, "tools", "osv-scanner-2.6.0");
    // A fake installer writing content whose hash isn't the pinned one.
    const installer = async (_command: string, args: ReadonlyArray<string>) => {
      calls.push(args[0]!);
      await mkdir(args[0]!, { recursive: true });
      await writeFile(join(args[0]!, "osv-scanner"), "not the real binary");
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(ensureOsvScanner(cache, installer, "darwin_arm64")).rejects.toThrow("doesn't match its pinned sha256");
    expect(calls).toEqual([binaryDir]);
    const failing = async () => ({ code: 1, stdout: "", stderr: "curl: (6) Could not resolve host\n" });
    await expect(ensureOsvScanner(cache, failing, "darwin_arm64")).rejects.toThrow("installing OSV-Scanner 2.6.0 failed: curl: (6) Could not resolve host");
  });
});
