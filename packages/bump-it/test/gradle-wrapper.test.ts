import { describe, expect, it } from "vitest";

import type { GateEnvironment } from "../../ci/src/gate.ts";
import type { Fetch } from "../../ci/src/http.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { gradleWrapperPlanner, WRAPPER_PROPERTIES } from "../src/gradle-wrapper.ts";
import { wrapperProperties } from "../src/wrapper-properties.ts";

const NOW = new Date("2026-10-07T00:00:00Z");
const SUM = "a".repeat(64);
const JAR = "b".repeat(64);
const ALL = "c".repeat(64);
const tree = (version = "8.0", type = "bin", checksum = SUM): Tree => ({
  id: "fixture", read: async (path) => path === WRAPPER_PROPERTIES
    ? `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-${type}.zip\ndistributionSha256Sum=${checksum}\n` : undefined,
  list: async () => [],
});
const release = (version: string, extra: object = {}) => ({
  version, buildTime: "20260901000000+0000", snapshot: false, broken: false, rcFor: "", milestoneFor: "",
  downloadUrl: `https://services.gradle.org/distributions/gradle-${version}-bin.zip`, checksum: SUM, wrapperChecksum: JAR,
  ...extra,
});
const advisory = (id: string, range = ">=8.0, <10.0", extra: object = {}) => ({
  ghsa_id: id, state: "published", vulnerabilities: [{ package: { ecosystem: "other", name: "Gradle" }, vulnerable_version_range: range }], ...extra,
});

function fixture(releases: unknown[] = [release("8.1"), release("9.0")], advisories: unknown[] = []) {
  const calls: string[] = [];
  const fetch: Fetch = async (url) => {
    calls.push(url);
    const data = url.endsWith("/versions/all") ? releases : url.includes("security-advisories") ? advisories : ALL;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => data, text: async () => String(data) };
  };
  const env: GateEnvironment = { fetch, now: () => NOW, run: async () => { throw new Error("no commands expected"); }, osvScanner: "unused", githubToken: "read" };
  return { calls, env, planner: gradleWrapperPlanner(env, 7) };
}

describe("Gradle wrapper candidates", () => {
  it("chooses the highest eligible release in the current and highest newer major, independently of listing order", async () => {
    const { planner } = fixture([release("8.2"), release("10.0"), release("8.10"), release("9.9"), release("8.1")]);
    const found = await planner.candidates(tree());
    expect(found.routine).toMatchObject({ ecosystem: "Gradle Wrapper", name: "gradle/gradle", from: "8.0", to: "8.10", major: false, mechanism: "gradle-wrapper" });
    expect(found.major).toMatchObject({ to: "10.0", major: true, wrapper: { distributionSha256: SUM, jarSha256: JAR } });
  });
  it("filters broken, snapshot, nightly, RC, milestone, future and young releases; includes the exact age boundary", async () => {
    const { planner } = fixture([
      release("8.1", { buildTime: "20260930000000+0000" }),
      release("8.2", { buildTime: "20260930000001+0000" }),
      release("8.3", { broken: true }), release("8.4", { snapshot: true }), release("8.5", { nightly: true }),
      release("8.6-rc-1"), release("8.7", { milestoneFor: "8.7" }), release("8.8", { rcFor: "8.8" }),
      release("8.9", { buildTime: "20261010000000+0000" }),
    ]);
    expect((await planner.candidates(tree())).routine?.to).toBe("8.1");
  });
  it("accepts the historical positive offset that stopped the real run", async () => {
    const { planner } = fixture([release("8.1", { buildTime: "20120612025621+0200" }), release("9.0")]);
    expect(await planner.candidates(tree())).toMatchObject({ routine: { to: "8.1" }, major: { to: "9.0" } });
  });
  it.each([
    ["20260930020000+0200", "20260930020001+0200"],
    ["20260929193000-0430", "20260929193001-0430"],
    ["20260930054500+0545", "20260930054501+0545"],
    ["20260930000000-0000", "20260930000001-0000"],
  ])("uses the UTC age boundary for %s", async (boundary, young) => {
    const { planner } = fixture([
      release("8.1", { buildTime: boundary }), release("8.2", { buildTime: young }),
    ]);
    expect((await planner.candidates(tree())).routine?.to).toBe("8.1");
  });
  it.each([
    "20260230000000+0200", "20260930240000+0000", "20260930000000+2400",
    "20260930000000-0060", "20260930000000Z", undefined,
  ])("skips an invalid timestamp %s without losing other eligible releases and keeps the note on recomputation", async (buildTime) => {
    const { planner, calls } = fixture([release("8.1"), release("8.2", { buildTime }), release("9.0")]);
    const found = await planner.candidates(tree());
    expect(found).toMatchObject({ routine: { to: "8.1" }, major: { to: "9.0" }, notes: [
      `Gradle release 8.2 skipped: invalid Gradle buildTime: ${String(buildTime)}`,
    ] });
    expect((await planner.candidates(tree("8.1"))).notes).toEqual(found.notes);
    expect(calls.filter((url) => url.endsWith("/versions/all"))).toHaveLength(1);
  });
  it("does not veto inherited advisories and falls back from releases that add a new one", async () => {
    const { planner } = fixture([release("8.1"), release("8.2"), release("9.0"), release("10.0")], [
      advisory("GHSA-inherited", ">=8.0, <10.0"), advisory("GHSA-new", ">=8.2, <9.0 || >=10.0"),
      advisory("GHSA-withdrawn", ">=8.0", { withdrawn_at: "2026-01-01T00:00:00Z" }),
      advisory("GHSA-draft", ">=8.0", { state: "draft" }),
    ]);
    const found = await planner.candidates(tree());
    expect(found.routine?.to).toBe("8.1");
    expect(found.major?.to).toBe("9.0");
  });
  it("selects through the real repository's mixed comparator and to range without adding the advisory", async () => {
    const { planner } = fixture([release("9.2.1"), release("9.3.0")], [advisory("GHSA-mqwm-5m85-gmcv", "< 8.14.4, 9.0.0 to 9.2.1", {
      vulnerabilities: [{ package: { ecosystem: "maven", name: "org.gradle:gradle-core" },
        vulnerable_version_range: "< 8.14.4, 9.0.0 to 9.2.1", patched_versions: "8.14.4, >= 9.3.0" }],
    })]);
    expect(await planner.candidates(tree("8.14.4"))).toMatchObject({ major: { to: "9.3.0" } });
    expect((await planner.candidates(tree("8.14.4"))).unavailable).toBeUndefined();
  });
  it("reads the published repository advisories and releases once for all candidates, recomputations and verification", async () => {
    const { planner, calls } = fixture();
    const move = (await planner.candidates(tree())).routine!;
    await planner.candidates(tree("8.1"));
    expect(await planner.verify([move], tree(), tree("8.1"), JAR)).toEqual([]);
    expect(calls.filter((url) => url.includes("security-advisories"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/versions/all"))).toHaveLength(1);
  });
  it("does not fetch for a repository without a root wrapper, and never downgrades", async () => {
    const { planner, calls } = fixture();
    expect(await planner.candidates({ ...tree(), read: async () => undefined })).toEqual({});
    expect(calls).toEqual([]);
    expect(await planner.candidates(tree("10.0"))).toEqual({});
  });
  it("preserves all distributions, reads their checksum, and falls back to canonical checksum URLs when metadata omits hashes", async () => {
    const { planner, calls } = fixture([release("8.1", { checksum: undefined, wrapperChecksum: undefined, checksumUrl: "https://evil.invalid" })]);
    const found = await planner.candidates(tree("8.0", "all"));
    expect(found.routine?.wrapper).toEqual({ distributionUrl: "https://services.gradle.org/distributions/gradle-8.1-all.zip", distributionSha256: ALL, jarSha256: ALL });
    expect(calls).toContain("https://services.gradle.org/distributions/gradle-8.1-all.zip.sha256");
    expect(calls).toContain("https://services.gradle.org/distributions/gradle-8.1-wrapper.jar.sha256");
    expect(calls.some((url) => url.includes("evil.invalid"))).toBe(false);
  });
  it("honors a maintainer's patched version on an open-ended range", async () => {
    const { planner } = fixture([release("8.1"), release("9.0")], [advisory("GHSA-new", ">=8.1", {
      vulnerabilities: [{ package: { ecosystem: "other", name: "Gradle" }, vulnerable_version_range: ">=8.1", patched_versions: "9.0" }],
    })]);
    expect(await planner.candidates(tree())).toMatchObject({ major: { to: "9.0" } });
    expect((await planner.candidates(tree())).routine).toBeUndefined();
  });
  it("reports omitted moves on unreadable advisory ranges, missing advisories, malformed releases and checksums", async () => {
    expect(await fixture(undefined, [advisory("GHSA-bad", "nonsense")]).planner.candidates(tree())).toMatchObject({ notes: [expect.stringContaining("unreadable")] });
    expect(await fixture([release("8.1", { buildTime: "20260230000000+0000" })]).planner.candidates(tree())).toMatchObject({ notes: [expect.stringContaining("buildTime")] });
    expect(await fixture([release("8.1", { checksum: "wrong" })]).planner.candidates(tree())).toMatchObject({ notes: [expect.stringContaining("checksum")] });
    expect(await fixture([release("8.1", { downloadUrl: "https://evil.invalid" })]).planner.candidates(tree())).toMatchObject({ notes: [expect.stringContaining("downloadUrl")] });
    const { env } = fixture();
    const unavailable: Fetch = async (url, init) => url.includes("security-advisories")
      ? { ok: false, status: 404, headers: { get: () => null }, json: async () => [], text: async () => "" } : env.fetch(url, init);
    expect(await gradleWrapperPlanner({ ...env, fetch: unavailable }, 7).candidates(tree())).toMatchObject({ notes: [expect.stringContaining("could not be read")] });
  });
  it("reports unsupported bases, empty vulnerabilities and service failures, but verification fails closed", async () => {
    const { env, planner } = fixture();
    const unsupported = { ...tree(), read: async () => "distributionUrl=https://mirror.invalid/gradle-8.0-bin.zip" };
    expect(await planner.candidates(unsupported)).toMatchObject({ notes: [expect.stringContaining("official stable")] });
    const missing = fixture(undefined, [{ ...advisory("GHSA-empty", "< 8.1"), vulnerabilities: [] }]);
    expect(await missing.planner.candidates(tree())).toMatchObject({ notes: [expect.stringContaining("no Gradle vulnerability ranges")] });
    const unavailable = gradleWrapperPlanner({ ...env, fetch: async () => { throw new Error("services unavailable"); } }, 7);
    expect(await unavailable.candidates(tree())).toEqual({ unavailable: true, notes: ["Gradle wrapper left out: services unavailable"] });
    const move = (await planner.candidates(tree())).routine!;
    await expect(unavailable.verify([move], tree(), tree("8.1"), JAR)).rejects.toThrow("services unavailable");
    await expect(missing.planner.verify([move], tree(), tree("8.1"), JAR)).rejects.toThrow("no Gradle vulnerability ranges");
  });

});

describe("Gradle wrapper verification", () => {
  it("rejects a planned target whose timestamp cannot be parsed even when other releases can be selected", async () => {
    const { planner } = fixture([release("8.1"), release("8.2", { buildTime: "20260230000000-0300" })]);
    const move = (await planner.candidates(tree())).routine!;
    expect(await planner.verify([{ ...move, to: "8.2" }], tree(), tree("8.2"), JAR)).toContainEqual(expect.stringContaining("aged release"));
  });
  it("checks official URL, distribution checksum and jar bytes separately, never trusting only the PR block", async () => {
    const { planner } = fixture();
    const move = (await planner.candidates(tree())).routine!;
    expect(await planner.verify([move], tree(), tree("8.1"), JAR)).toEqual([]);
    expect(await planner.verify([move], tree(), tree("8.1", "bin", "wrong"), JAR)).toContainEqual(expect.stringContaining("distributionSha256Sum"));
    expect(await planner.verify([move], tree(), tree("8.2"), JAR)).toContainEqual(expect.stringContaining("distributionUrl"));
    expect(await planner.verify([move], tree(), tree("8.1"), "wrong")).toContainEqual(expect.stringContaining("wrapper checksum"));
    expect(await planner.verify([{ ...move, wrapper: { ...move.wrapper!, jarSha256: "d".repeat(64) } }], tree(), tree("8.1"), JAR)).toContainEqual(expect.stringContaining("plan does not match"));
  });
  it("rejects a wrong base, duplicate moves, a young or advisory-adding target and wrong major flag", async () => {
    const { planner } = fixture([release("8.1"), release("9.0", { buildTime: "20261006000000+0000" }), release("10.0")], [advisory("GHSA-new", ">=10.0")]);
    const move = (await planner.candidates(tree())).routine!;
    expect(await planner.verify([move], tree("8.2"), tree("8.1"), JAR)).toContainEqual(expect.stringContaining("source version"));
    expect(await planner.verify([move, move], tree(), tree("8.1"), JAR)).toContainEqual(expect.stringContaining("exactly one"));
    expect(await planner.verify([{ ...move, to: "9.0", major: true }], tree(), tree("9.0"), JAR)).toContainEqual(expect.stringContaining("aged release"));
    expect(await planner.verify([{ ...move, to: "10.0", major: true }], tree(), tree("10.0"), JAR)).toEqual(["Gradle 10.0 adds GHSA-new"]);
    expect(await planner.verify([{ ...move, major: true }], tree(), tree("8.1"), JAR)).toContainEqual(expect.stringContaining("major flag"));
  });
});

describe("wrapper properties", () => {
  it("reads escaped URLs, unicode keys, whitespace separators and continued values as Java properties", () => {
    const text = "# comment\r\ndistribution\\u0055rl : https\\://services.gradle.org/\\\r\n  distributions/gradle-8.1-bin.zip\r\ndistributionSha256Sum " + SUM;
    expect(wrapperProperties(text).get("distributionUrl")).toBe("https://services.gradle.org/distributions/gradle-8.1-bin.zip");
    expect(wrapperProperties(text).get("distributionSha256Sum")).toBe(SUM);
  });
  it("rejects duplicate keys and incomplete continuations", () => {
    expect(() => wrapperProperties("distributionUrl=x\ndistributionUrl=y")).toThrow("duplicate");
    expect(() => wrapperProperties("key=value\\")).toThrow("continuation");
  });
});
