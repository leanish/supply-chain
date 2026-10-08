import { describe, expect, it } from "vitest";

import { nodeRuntime, nodeTypeProblem, nodeTypeVersions } from "../src/node-runtime.ts";
import type { Tree } from "../src/tree.ts";

const declarations = [{ lockfile: "package-lock.json", workspace: "." }];

function tree(files: Record<string, string>): Tree {
  return { id: "base", read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)) };
}

function workflow(value: string, matrix = ""): string {
  return `jobs:\n  check:\n${matrix}    steps:\n      - uses: actions/setup-node@v6\n        with:\n          node-version: ${value}\n`;
}

describe("supported Node runtime", () => {
  it.each([
    [">=24", 24],
    [">=24 <25", 24],
    [">=22.4.0 <25", 22],
    ["^20.19.0 || >=24", 20],
    ["not a range", undefined],
    ["*", undefined],
  ])("uses the minimum runtime in engines.node %s", async (range, major) => {
    const runtime = await nodeRuntime(tree({ "package.json": JSON.stringify({ engines: { node: range } }) }), declarations);
    expect(runtime.major).toBe(major);
  });

  it.each([
    [".nvmrc", "24\n", 24],
    [".nvmrc", "v24.10.0\n", 24],
    [".node-version", "22.18.0\n", 22],
    [".nvmrc", "lts/*\n", undefined],
    [".node-version", "garbage", undefined],
  ])("reads a pinned runtime from %s (%s)", async (path, value, major) => {
    expect((await nodeRuntime(tree({ [path]: value }), declarations)).major).toBe(major);
  });

  it("reads Volta's runtime and keeps a lower engines floor despite newer development and CI versions", async () => {
    const runtime = await nodeRuntime(tree({
      "package.json": JSON.stringify({ engines: { node: "^22 || ^24" }, volta: { node: "24.10.0" } }),
      ".nvmrc": "26",
      ".github/workflows/check.yml": workflow("26"),
    }), declarations);
    expect(runtime.major).toBe(22);
    expect(runtime.sources).toContain("package.json: volta.node");
    expect(runtime.sources).toContain(".github/workflows/check.yml: node-version");
  });

  it("uses Volta when there is no engines range", async () => {
    expect((await nodeRuntime(tree({ "package.json": JSON.stringify({ volta: { node: "24.10.0" } }) }), declarations)).major).toBe(24);
  });

  it("reads static CI versions and a matrix including its extra rows", async () => {
    const files = {
      ".github/workflows/other.yml": workflow("26"),
      ".github/workflows/check.yaml": workflow("${{ matrix.node }}", "    strategy:\n      matrix:\n        node: [24, 26]\n        include:\n          - node: 22\n"),
    };
    expect((await nodeRuntime(tree(files), declarations)).major).toBe(22);
  });

  it("reads the runtime passed to a reusable CI workflow", async () => {
    const runtime = await nodeRuntime(tree({
      ".github/workflows/check.yml": "jobs:\n  check:\n    uses: acme/ci/.github/workflows/check.yml@main\n    with:\n      node-version: 24\n",
    }), declarations);
    expect(runtime.major).toBe(24);
  });

  it("ignores unrelated actions, unreadable YAML and unresolved expressions", async () => {
    const runtime = await nodeRuntime(tree({
      ".github/workflows/check.yml": workflow("24").replace("actions/setup-node", "acme/other"),
      ".github/workflows/broken.yaml": "jobs: [",
      ".github/workflows/dynamic.yml": workflow("${{ inputs.node-version }}"),
    }), declarations);
    expect(runtime.major).toBeUndefined();
    expect(nodeTypeProblem(runtime)).toContain("keeping the current @types/node major");
  });

  it("includes nested lockfile and workspace support floors instead of using only the root", async () => {
    const runtime = await nodeRuntime(tree({
      "package.json": JSON.stringify({ engines: { node: ">=24" } }),
      "tools/package.json": JSON.stringify({ volta: { node: "24.10.0" } }),
      "tools/packages/old/package.json": JSON.stringify({ engines: { node: ">=22" } }),
    }), [{ lockfile: "tools/package-lock.json", workspace: "packages/old" }]);
    expect(runtime.major).toBe(22);
    expect(runtime.sources).toContain("tools/packages/old/package.json: engines.node");
  });
});

describe("Node type candidates", () => {
  it("caps routine and major candidates, rather than dropping only the newest major", () => {
    expect(nodeTypeVersions("22.0.0", ["22.1.0", "24.19.0", "26.6.3"], { major: 24, sources: [] })).toEqual(["22.1.0", "24.19.0"]);
    expect(nodeTypeVersions("26.0.0", ["26.1.0"], { major: 24, sources: [] })).toEqual([]);
  });

  it("allows current-major updates without runtime evidence, but no change of major", () => {
    expect(nodeTypeVersions("24.19.0", ["24.20.0", "25.0.0", "26.6.3"], { major: undefined, sources: [] })).toEqual(["24.20.0"]);
  });
});
