import { describe, expect, it } from "vitest";

import { NO_EXCEPTIONS, parseExceptions } from "../src/exceptions.ts";
import { compareFindings, findingsOf, type Located } from "../src/findings.ts";
import { comparisonVerdict, scanVerdict } from "../src/policy.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";

const TODAY = "2026-10-06";

function advisory(id: string, aliases: string[] = [], options: Partial<Advisory> = {}): Advisory {
  return { id, ids: [id, ...aliases], source: "osv", malicious: false, summary: undefined, severity: undefined, ...options };
}

function npm(name: string, version: string, locations = [`node_modules/${name}`]): Located {
  return { ecosystem: "npm", name, version, locations };
}

/** A snapshot from `name@version` → advisories. */
function snapshot(affecting: Record<string, Advisory[]>): Snapshot {
  const entries = Object.entries(affecting).map(([key, advisories]) => {
    const at = key.lastIndexOf("@");
    return [`npm|${key.slice(0, at)}|${key.slice(at + 1)}`, advisories] as const;
  });
  return new Snapshot(new Map(entries), [], new Date(`${TODAY}T12:00:00Z`));
}

function verdict(base: Located[], head: Located[], snap: Snapshot, exceptions = NO_EXCEPTIONS) {
  return comparisonVerdict(compareFindings(findingsOf(base, snap), findingsOf(head, snap)), exceptions, snap, TODAY);
}

describe("comparison policy", () => {
  it("passes an upgrade that fixes A while B stays, reporting B as inherited and A as fixed", () => {
    const snap = snapshot({
      "lib@1.0.0": [advisory("GHSA-a"), advisory("GHSA-b")],
      "lib@1.1.0": [advisory("GHSA-b")],
    });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "1.1.0")], snap);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual(["inherited: lib@1.1.0: GHSA-b"]);
    expect(result.notes).toEqual(["fixed: lib@1.0.0: GHSA-a"]);
  });

  it("warns on a new advisory for a dependency both sides share", () => {
    // Published after base was merged: both sides read it from the same snapshot.
    const snap = snapshot({ "lib@1.0.0": [advisory("GHSA-new")], "other@2.0.0": [] });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "1.0.0"), npm("other", "2.0.0")], snap);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual(["inherited: lib@1.0.0: GHSA-new"]);
  });

  it("fails a finding the PR adds, by a new package or by a version that brings a new advisory", () => {
    const snap = snapshot({
      "lib@1.0.0": [advisory("GHSA-b")],
      "lib@2.0.0": [advisory("GHSA-b"), advisory("GHSA-c")],
      "added@1.0.0": [advisory("GHSA-d")],
    });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "2.0.0"), npm("added", "1.0.0")], snap);
    expect(result.failures).toEqual(["new: lib@2.0.0: GHSA-c has no exception", "new: added@1.0.0: GHSA-d has no exception"]);
  });

  it("counts a finding as the same across versions and copies of a package", () => {
    const snap = snapshot({ "lib@1.0.0": [advisory("GHSA-b")], "lib@1.0.1": [advisory("GHSA-b")] });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "1.0.0"), npm("lib", "1.0.1", ["node_modules/x/node_modules/lib"])], snap);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it("fails malware in head even when base already had it, bundled copies included", () => {
    const mal = advisory("MAL-2026-1", [], { malicious: true });
    const snap = snapshot({ "evil@1.0.0": [mal] });
    const bundled = npm("evil", "1.0.0", ["node_modules/cdk/node_modules/evil"]);
    const result = verdict([bundled], [bundled], snap);
    expect(result.failures).toEqual(["inherited: evil@1.0.0: MAL-2026-1 is a known-malicious package (no exception can cover it)"]);
  });

  it("passes removing malware", () => {
    const snap = snapshot({ "evil@1.0.0": [advisory("MAL-2026-1", [], { malicious: true })] });
    expect(verdict([npm("evil", "1.0.0")], [], snap).failures).toEqual([]);
  });

  it("matches findings across sources and ids through their aliases", () => {
    // Base's version is known to OSV under the CVE; head's to the repository under the GHSA.
    const snap = snapshot({
      "lib@1.0.0": [advisory("CVE-2026-1", ["GHSA-x"])],
      "lib@1.0.1": [advisory("GHSA-x", [], { source: "repository" })],
    });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "1.0.1")], snap);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual(["inherited: lib@1.0.1: GHSA-x"]);
  });

  it("joins alias chains into one group with a stable canonical id", () => {
    const snap = snapshot({ "lib@1.0.0": [advisory("CVE-2026-1", ["GHSA-zz"]), advisory("PYSEC-1", ["CVE-2026-1", "GHSA-aa"])] });
    expect(snap.group("PYSEC-1")).toBe("GHSA-aa");
    expect(snap.group("GHSA-zz")).toBe("GHSA-aa");
    expect(findingsOf([npm("lib", "1.0.0")], snap).map((f) => [f.advisory, f.ids])).toEqual([
      ["GHSA-aa", ["CVE-2026-1", "GHSA-aa", "GHSA-zz", "PYSEC-1"]],
    ]);
  });

  it("lets an exception cover an added finding by any alias, only at the paths it names and until it expires", () => {
    const snap = snapshot({ "lib@1.0.0": [advisory("GHSA-v", ["CVE-2026-9"])] });
    const head = [npm("lib", "1.0.0", ["node_modules/lib", "node_modules/cdk/node_modules/lib"])];
    const excepted = (paths: string[], expires = "2026-12-31", id = "CVE-2026-9") =>
      parseExceptions({ vulnerabilities: [{ id, package: "lib", version: "1.0.0", paths, reason: "not reachable", expires }] });
    expect(verdict([], head, snap, excepted(["node_modules/lib", "node_modules/cdk/node_modules/lib"])).failures).toEqual([]);
    expect(verdict([], head, snap, excepted(["node_modules/cdk/node_modules/lib"])).failures).toEqual([
      "new: lib@1.0.0: GHSA-v at node_modules/lib isn't covered by its exception's paths",
    ]);
    expect(verdict([], head, snap, excepted(["node_modules/lib", "node_modules/cdk/node_modules/lib"], "2026-10-05")).failures).toEqual([
      "new: lib@1.0.0: GHSA-v: its exception expired on 2026-10-05",
    ]);
  });

  it("never lets an exception cover malware, even under a GHSA id tagged CWE-506", () => {
    const snap = snapshot({ "hijacked@0.7.29": [advisory("GHSA-m", [], { malicious: true })] });
    const excepted = parseExceptions({
      vulnerabilities: [{ id: "GHSA-m", package: "hijacked", version: "0.7.29", paths: ["node_modules/hijacked"], reason: "trust me", expires: "2027-01-01" }],
    });
    expect(verdict([], [npm("hijacked", "0.7.29")], snap, excepted).failures).toEqual([
      "new: hijacked@0.7.29: GHSA-m is a known-malicious package (no exception can cover it)",
    ]);
  });
});

describe("full scan policy", () => {
  it("fails every finding without a valid exception and notes the excepted ones", () => {
    const snap = snapshot({ "a@1.0.0": [advisory("GHSA-a")], "b@1.0.0": [advisory("GHSA-b")] });
    const exceptions = parseExceptions({
      vulnerabilities: [{ id: "GHSA-b", package: "b", version: "1.0.0", paths: ["node_modules/b"], reason: "build only", expires: "2027-01-01" }],
    });
    const result = scanVerdict(findingsOf([npm("a", "1.0.0"), npm("b", "1.0.0")], snap), exceptions, snap, TODAY);
    expect(result.failures).toEqual(["a@1.0.0: GHSA-a has no exception"]);
    expect(result.notes).toEqual(["excepted: b@1.0.0: GHSA-b"]);
  });
});

describe("exceptions file", () => {
  const entry = { package: "a", version: "1.0.0", advisory: "GHSA-a", reason: "fixes GHSA-a", expires: "2027-01-01" };

  it("requires trimmed, nonempty fields and a real YYYY-MM-DD expiry", () => {
    expect(() => parseExceptions({ releaseAge: [{ ...entry, reason: "  " }] })).toThrow(/reason is required/);
    expect(() => parseExceptions({ releaseAge: [{ ...entry, reason: " padded" }] })).toThrow(/reason is required/);
    expect(() => parseExceptions({ releaseAge: [{ ...entry, ecosystem: "" }] })).toThrow(/ecosystem is required/);
    expect(() => parseExceptions({ releaseAge: [{ ...entry, expires: "soon" }] })).toThrow(/real YYYY-MM-DD/);
    expect(() => parseExceptions({ releaseAge: [{ ...entry, expires: "2027-02-30" }] })).toThrow(/real YYYY-MM-DD/);
  });

  it("rejects malware ids and duplicates", () => {
    expect(() => parseExceptions({ releaseAge: [{ ...entry, advisory: "MAL-2026-1" }] })).toThrow(/known-malicious/);
    expect(() => parseExceptions({ releaseAge: [entry, { ...entry, reason: "again" }] })).toThrow(/duplicates/);
    expect(parseExceptions({ releaseAge: [entry, { ...entry, ecosystem: "Maven" }] }).releaseAge).toHaveLength(2);
    expect(() => parseExceptions({ vulnerabilities: "nope" })).toThrow(/must be an array/);
  });

  it("requires a vulnerability exception to name the paths it covers", () => {
    const vulnerability = { id: "GHSA-v", package: "lib", version: "1.0.0", reason: "not reachable", expires: "2027-01-01" };
    expect(() => parseExceptions({ vulnerabilities: [vulnerability] })).toThrow(/paths must be a nonempty list/);
    expect(() => parseExceptions({ vulnerabilities: [{ ...vulnerability, paths: [] }] })).toThrow(/paths must be a nonempty list/);
    expect(() => parseExceptions({ vulnerabilities: [{ ...vulnerability, paths: [" node_modules/lib"] }] })).toThrow(/paths/);
    expect(() => parseExceptions({ vulnerabilities: [{ ...vulnerability, paths: ["node_modules/lib", "node_modules/lib"] }] })).toThrow(
      /distinct/,
    );
  });
});
