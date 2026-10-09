import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { namingFailures } from "../src/http.ts";
import { workingTree } from "../src/tree.ts";

let root: string;

describe("the working tree", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "supply-chain-tree-"));
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, ".github/workflows/ci.yml"), "on: push\n");
  });

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("has no file under a path whose parent is a file", async () => {
    const tree = workingTree(root);
    expect(await tree.read(".github/workflows/ci.yml")).toBe("on: push\n");
    expect(await tree.read(".github/workflows/ci.yml/action.yml")).toBeUndefined();
    expect(await tree.read("missing/action.yml")).toBeUndefined();
    expect(await tree.list(".github/workflows/ci.yml")).toEqual([]);
  });
});

describe("network errors", () => {
  it("name the request and the reason undici keeps in the cause", async () => {
    const failing = namingFailures(async () => {
      throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    });
    await expect(failing("https://registry.npmjs.org/vite", { method: "GET" })).rejects.toThrow(
      "GET https://registry.npmjs.org/vite failed: read ECONNRESET",
    );
    const plain = namingFailures(async () => {
      throw new Error("aborted");
    });
    await expect(plain("https://api.github.com/x", { method: "HEAD" })).rejects.toThrow("HEAD https://api.github.com/x failed: aborted");
    const codeOnly = namingFailures(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(""), { code: "UND_ERR_SOCKET" }) });
    }, { sleep: async () => {}, random: () => 0.5 });
    await expect(codeOnly("https://plugins.gradle.org/m2/x.pom")).rejects.toThrow("GET https://plugins.gradle.org/m2/x.pom failed: UND_ERR_SOCKET");
  });
});
