import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { lockedPackages } from "../src/npm-lock.ts";
import { archive, manifest, serving, tar, type TarEntry } from "./tarballs.ts";
import { BUNDLE_LIMITS, type BundleContents, BundleReader, bundleMismatches, type FetchArchive, tarballUrl } from "../src/npm-bundles.ts";

const CARRIER: TarEntry[] = [
  { path: "package/", type: "5" },
  { path: "package/package.json", body: manifest("carrier", "1.0.0", { bundleDependencies: ["inner", "@scope/tool"] }) },
  { path: "package/index.js", body: "module.exports = 1;" },
  { path: "package/node_modules/inner/package.json", body: manifest("inner", "2.0.0", { dependencies: { leaf: "^3.0.0" }, peerDependencies: { host: "*" }, peerDependenciesMeta: { host: { optional: true } } }) },
  { path: "package/node_modules/inner/lib/package.json", body: manifest("not-a-root", "9.9.9") },
  { path: "package/node_modules/inner/node_modules/leaf/package.json", body: manifest("leaf", "3.1.0") },
  { path: "package/node_modules/@scope/tool/package.json", body: manifest("@scope/tool", "1.2.3") },
];

const URL_1 = "https://registry.npmjs.org/carrier/-/carrier-1.0.0.tgz";

async function read(entries: ReadonlyArray<TarEntry>, options: { end?: boolean; limits?: Partial<typeof BUNDLE_LIMITS>; integrity?: string } = {}): Promise<BundleContents> {
  const { bytes, integrity } = archive(entries, options.end);
  return new BundleReader(serving({ [URL_1]: bytes }), { ...BUNDLE_LIMITS, ...options.limits }).read("carrier", "1.0.0", options.integrity ?? integrity);
}

function reasonOf(contents: BundleContents): string {
  if (contents.complete) throw new Error("expected an unknown bundle");
  return contents.reason;
}

describe("reading what an npm archive bundles", () => {
  it("lists every bundled package root, scoped and nested, with its requirements", async () => {
    const contents = await read(CARRIER);
    expect(contents).toEqual({
      complete: true,
      packages: [
        { path: "node_modules/@scope/tool", installedAs: "@scope/tool", name: "@scope/tool", version: "1.2.3", dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {}, bundleDependencies: false },
        {
          path: "node_modules/inner", installedAs: "inner", name: "inner", version: "2.0.0",
          dependencies: { leaf: "^3.0.0" }, optionalDependencies: {}, peerDependencies: { host: "*" }, peerDependenciesMeta: { host: { optional: true } }, bundleDependencies: false,
        },
        { path: "node_modules/inner/node_modules/leaf", installedAs: "leaf", name: "leaf", version: "3.1.0", dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {}, bundleDependencies: false },
      ],
    });
  });

  it("keeps an alias's installed key apart from the package it holds", async () => {
    const contents = await read([...CARRIER, { path: "package/node_modules/compat/package.json", body: manifest("real-lib", "4.0.0") }]);
    expect(contents.complete && contents.packages.find((pkg) => pkg.path === "node_modules/compat")).toMatchObject({ installedAs: "compat", name: "real-lib" });
  });

  it("reads long paths from pax headers and GNU long names", async () => {
    const deep = `package/node_modules/${"a".repeat(60)}/node_modules/${"b".repeat(60)}`;
    const contents = await read([
      ...CARRIER,
      { path: `package/node_modules/${"a".repeat(60)}/package.json`, body: manifest("a".repeat(60), "1.0.0"), pax: true },
      { path: `${deep}/package.json`, body: manifest("b".repeat(60), "1.0.0"), gnu: true },
    ]);
    expect(contents.complete && contents.packages.map((pkg) => pkg.path)).toEqual(expect.arrayContaining([
      `node_modules/${"a".repeat(60)}`,
      `node_modules/${"a".repeat(60)}/node_modules/${"b".repeat(60)}`,
    ]));
  });

  it("reads a bundle-less archive as complete and empty", async () => {
    expect(await read([{ path: "package/package.json", body: manifest("carrier", "1.0.0") }])).toEqual({ complete: true, packages: [] });
  });

  it("downloads each archive once per integrity", async () => {
    const { bytes, integrity } = archive(CARRIER);
    const requests: string[] = [];
    const reader = new BundleReader(serving({ [URL_1]: bytes }, requests));
    await reader.read("carrier", "1.0.0", integrity);
    await reader.read("carrier", "1.0.0", integrity);
    expect(requests).toEqual([URL_1]);
  });

  it.each([
    ["an archive that isn't the authenticated one", { integrity: `sha512-${createHash("sha512").update("other").digest("base64")}` }, "doesn't match its sha512 integrity"],
    ["no sha512 to check against", { integrity: "sha1-abc" }, "no sha512 integrity"],
    ["two sha512 digests that disagree", { integrity: "sha512-AAAA sha512-BBBB" }, "no sha512 integrity"],
  ])("can't tell with %s", async (_, options, reason) => {
    expect(reasonOf(await read(CARRIER, options))).toContain(reason);
  });

  it.each<[string, TarEntry[], string]>([
    ["a symbolic link", [...CARRIER, { path: "package/node_modules/link", type: "2" }], "unsupported tar entry type"],
    ["a path climbing out", [...CARRIER, { path: "package/../escape/package.json", body: "{}" }], "unsafe tar path"],
    ["an absolute path", [...CARRIER, { path: "/etc/package.json", body: "{}" }], "unsafe tar path"],
    ["a second top directory", [...CARRIER, { path: "other/node_modules/x/package.json", body: manifest("x", "1.0.0") }], "two top directories"],
    ["the same path twice", [...CARRIER, { path: "package/node_modules/inner/package.json", body: manifest("inner", "2.0.1") }], "twice"],
    ["no root manifest", CARRIER.filter((entry) => entry.path !== "package/package.json"), "has no package.json"],
    ["a root manifest naming another package", [{ path: "package/package.json", body: manifest("impostor", "1.0.0") }], "doesn't name carrier@1.0.0"],
    ["an unreadable bundled manifest", [...CARRIER, { path: "package/node_modules/broken/package.json", body: "{" }], "unreadable bundled manifest"],
    ["a bundled version that isn't one", [...CARRIER, { path: "package/node_modules/odd/package.json", body: manifest("odd", "latest") }], "unreadable bundled manifest"],
    ["non-string requirements", [...CARRIER, { path: "package/node_modules/odd/package.json", body: manifest("odd", "1.0.0", { dependencies: { x: 1 } }) }], "unreadable bundled manifest"],
  ])("can't tell with %s", async (_, entries, reason) => {
    expect(reasonOf(await read(entries))).toContain(reason);
  });

  it.each([
    ["a bundled package's files without its package.json", "package/node_modules/brace/index.js", "node_modules/brace has files but no package.json"],
    ["a scoped one's", "package/node_modules/@scope/hidden/lib/index.js", "node_modules/@scope/hidden has files but no package.json"],
    ["a nested one's", "package/node_modules/inner/node_modules/deep/index.js", "node_modules/inner/node_modules/deep has files but no package.json"],
  ])("can't tell from %s, which Node could still run", async (_, path, reason) => {
    expect(reasonOf(await read([...CARRIER, { path, body: "module.exports = 1;" }]))).toContain(reason);
  });

  it("doesn't take npm's `.bin` for a package", async () => {
    expect((await read([...CARRIER, { path: "package/node_modules/.bin/tool", body: "#!/bin/sh" }])).complete).toBe(true);
  });

  it("reads a bundled package's own bundle list", async () => {
    const contents = await read([...CARRIER, { path: "package/node_modules/nested/package.json", body: manifest("nested", "1.0.0", { bundledDependencies: ["x"] }) }]);
    expect(contents.complete && contents.packages.find((pkg) => pkg.name === "nested")?.bundleDependencies).toEqual(["x"]);
  });

  it("can't tell from an archive without its end-of-archive blocks", async () => {
    expect(reasonOf(await read(CARRIER, { end: false }))).toContain("end-of-archive");
  });

  it("can't tell from a truncated download", async () => {
    const { bytes, integrity } = archive(CARRIER);
    const reader = new BundleReader(serving({ [URL_1]: bytes.subarray(0, bytes.length - 40) }));
    expect((await reader.read("carrier", "1.0.0", integrity)).complete).toBe(false);
  });

  it("can't tell from a corrupt header", async () => {
    const raw = tar(CARRIER);
    raw[600] = raw[600]! ^ 0xff;
    const bytes = gzipSync(raw);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    expect(reasonOf(await new BundleReader(serving({ [URL_1]: bytes })).read("carrier", "1.0.0", integrity))).toContain("checksum");
  });

  it.each<[string, Partial<typeof BUNDLE_LIMITS>, string]>([
    ["compressed bytes", { compressedBytes: 100 }, "compressed bytes"],
    ["unpacked bytes", { unpackedBytes: 2_000 }, "unpacked bytes"],
    ["entries", { entries: 3 }, "entries"],
    ["manifest size", { manifestBytes: 20 }, "bytes"],
  ])("stops at its budget of %s", async (_, limits, reason) => {
    expect(reasonOf(await read(CARRIER, { limits }))).toContain(reason);
  });

  it("shares one download budget across the run", async () => {
    const first = archive(CARRIER);
    const second = archive([{ path: "package/package.json", body: manifest("other", "1.0.0") }]);
    const reader = new BundleReader(
      serving({ [URL_1]: first.bytes, "https://registry.npmjs.org/other/-/other-1.0.0.tgz": second.bytes }),
      { ...BUNDLE_LIMITS, runBytes: first.bytes.length + 10 },
    );
    expect((await reader.read("carrier", "1.0.0", first.integrity)).complete).toBe(true);
    expect(reasonOf(await reader.read("other", "1.0.0", second.integrity))).toContain("budget");
  });

  it("can't tell when the registry doesn't serve the archive", async () => {
    expect(reasonOf(await new BundleReader(serving({})).read("carrier", "1.0.0", archive(CARRIER).integrity))).toContain("HTTP 404");
  });

  it("forms the registry's own tarball URL and refuses names that would escape it", () => {
    expect(tarballUrl("@scope/tool", "1.2.3")).toBe("https://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz");
    expect(() => tarballUrl("../evil", "1.0.0")).toThrow("no registry tarball URL");
    expect(() => tarballUrl("lib", "1.0.0?x")).toThrow("no registry tarball URL");
  });
});

describe("comparing an archive with the lockfile", () => {
  const contents = { complete: true as const, packages: [
    { path: "node_modules/inner", installedAs: "inner", name: "inner", version: "2.0.0", dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {}, bundleDependencies: false },
    { path: "node_modules/inner/node_modules/leaf", installedAs: "leaf", name: "leaf", version: "3.1.0", dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {}, bundleDependencies: false },
  ] };
  const carrier = "node_modules/carrier";
  const locked = (entries: Record<string, unknown>) => lockedPackages({ lockfileVersion: 3, packages: {
    "": { name: "app" },
    [carrier]: { version: "1.0.0" },
    "node_modules/carrier-sibling": { version: "1.0.0" },
    "node_modules/carrier-sibling/node_modules/inner": { version: "1.0.0", inBundle: true },
    ...entries,
  } });

  it("agrees when every bundled entry is recorded as shipped", () => {
    expect(bundleMismatches(locked({
      [`${carrier}/node_modules/inner`]: { version: "2.0.0", inBundle: true },
      [`${carrier}/node_modules/inner/node_modules/leaf`]: { version: "3.1.0", inBundle: true },
    }), carrier, contents)).toEqual([]);
  });

  it("reports omitted, extra and different entries", () => {
    expect(bundleMismatches(locked({
      [`${carrier}/node_modules/inner`]: { version: "2.0.1", inBundle: true },
      [`${carrier}/node_modules/ghost`]: { version: "1.0.0", inBundle: true },
      [`${carrier}/node_modules/not-bundled`]: { version: "1.0.0" },
    }), carrier, contents)).toEqual([
      "node_modules/carrier ships inner@2.0.0 at node_modules/inner, but the lockfile records inner@2.0.1",
      "node_modules/carrier ships leaf@3.1.0 at node_modules/inner/node_modules/leaf, which the lockfile doesn't record",
      "the lockfile records ghost@1.0.0 at node_modules/carrier/node_modules/ghost, which node_modules/carrier's archive doesn't ship",
    ]);
  });
});
