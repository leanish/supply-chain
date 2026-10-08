import { describe, expect, it } from "vitest";

import { inAdvisoryRange, versionScheme } from "../src/versions.ts";

const npm = versionScheme("npm");
const maven = versionScheme("Maven");

function expectAscending(scheme: typeof npm, versions: ReadonlyArray<string>): void {
  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      expect(scheme.compare(versions[i]!, versions[j]!), `${versions[i]} < ${versions[j]}`).toBeLessThan(0);
      expect(scheme.compare(versions[j]!, versions[i]!), `${versions[j]} > ${versions[i]}`).toBeGreaterThan(0);
    }
  }
}

describe("npm (SemVer 2.0)", () => {
  it("orders by precedence, prereleases before their release", () => {
    expectAscending(npm, [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.9.4",
      "1.9.5",
      "1.10.0",
      "2.0.0",
    ]);
    expect(npm.compare("1.0.0+build.1", "1.0.0")).toBe(0);
  });

  it("names caret lines", () => {
    expect(npm.line("1.9.4")).toBe("1");
    expect(npm.line("0.14.2")).toBe("0.14");
    expect(npm.line("0.0.3")).toBe("0.0.3");
  });

  it("knows prereleases and has no flavors", () => {
    expect(npm.isPrerelease("2.0.0-rc.1")).toBe(true);
    expect(npm.isPrerelease("2.0.0")).toBe(false);
    expect(npm.flavor("2.0.0")).toBe("");
  });

  it("rejects what isn't SemVer", () => {
    expect(() => npm.compare("1.0", "1.0.0")).toThrow("not a SemVer version: 1.0");
  });
});

describe("Maven (ComparableVersion)", () => {
  // Maven's own ComparableVersionTest vectors, each list ascending.
  it("orders qualifiers", () => {
    expectAscending(maven, [
      "1-alpha2snapshot",
      "1-alpha2",
      "1-alpha-123",
      "1-beta-2",
      "1-beta123",
      "1-m2",
      "1-m11",
      "1-rc",
      "1-cr2",
      "1-rc123",
      "1-SNAPSHOT",
      "1",
      "1-sp",
      "1-sp2",
      "1-sp123",
      "1-abc",
      "1-def",
      "1-pom-1",
      "1-1-snapshot",
      "1-1",
      "1-2",
      "1-123",
    ]);
  });

  it("orders numbers", () => {
    expectAscending(maven, [
      "2.0",
      "2.0.a",
      "2-1",
      "2.0.2",
      "2.0.123",
      "2.1.0",
      "2.1-a",
      "2.1b",
      "2.1-c",
      "2.1-1",
      "2.1.0.1",
      "2.2",
      "2.123",
      "11.a2",
      "11.a11",
      "11.b2",
      "11.b11",
      "11.m2",
      "11.m11",
      "11",
      "11.a",
      "11b",
      "11c",
      "11m",
    ]);
  });

  it("treats equivalent spellings as equal", () => {
    for (const [a, b] of [
      ["1", "1.0.0"],
      ["1-ga", "1"],
      ["1.0.Final", "1"],
      ["1-release", "1"],
      ["1-cr1", "1-rc1"],
      ["1a1", "1-alpha-1"],
      ["1.0-SNAPSHOT", "1-snapshot"],
    ] as const) {
      expect(maven.compare(a, b), `${a} == ${b}`).toBe(0);
    }
  });

  it("orders the versions this repo meets", () => {
    expectAscending(maven, ["1.1.10.8", "1.1.10.9", "1.1.10.10"]);
    expectAscending(maven, ["33.7.1-jre", "33.7.2-jre", "33.8.0-jre"]);
    expectAscending(maven, ["2.0.0-rc1", "2.0.0", "2.0.1"]);
  });

  it("names lines, prereleases and flavors", () => {
    expect(maven.line("1.1.10.8")).toBe("1");
    expect(maven.line("0.14.2")).toBe("0.14");
    expect(maven.line("33.7.2-jre")).toBe("33");
    expect(maven.isPrerelease("2.0.0-M1")).toBe(true);
    expect(maven.isPrerelease("6.0.0-RC2")).toBe(true);
    expect(maven.isPrerelease("1.0.0-SNAPSHOT")).toBe(true);
    expect(maven.isPrerelease("33.7.2-jre")).toBe(false);
    expect(maven.isPrerelease("5.6.0.Final")).toBe(false);
    expect(maven.flavor("33.7.2-jre")).toBe("jre");
    expect(maven.flavor("33.7.2-android")).toBe("android");
    expect(maven.flavor("5.6.0.Final")).toBe("");
    expect(maven.flavor("1.1.10.8")).toBe("");
  });
});

describe("advisory ranges", () => {
  it("reads GitHub's database format, the comma meaning AND", () => {
    expect(inAdvisoryRange(maven, "<= 1.1.10.8", "1.1.10.8")).toBe(true);
    expect(inAdvisoryRange(maven, "<= 1.1.10.8", "1.1.10.9")).toBe(false);
    expect(inAdvisoryRange(npm, ">= 1.0.0, < 1.2.2", "1.2.1")).toBe(true);
    expect(inAdvisoryRange(npm, ">= 1.0.0, < 1.2.2", "1.2.2")).toBe(false);
    expect(inAdvisoryRange(npm, ">= 1.0.0, < 1.2.2", "0.9.0")).toBe(false);
    expect(inAdvisoryRange(npm, "= 1.2.1", "1.2.1")).toBe(true);
    expect(inAdvisoryRange(npm, "1.2.1", "1.2.2")).toBe(false);
    expect(inAdvisoryRange(npm, ">= 2.0.0", "3.0.0")).toBe(true);
  });

  it("reads maintainers' formats: comma as OR, spaces as AND, hyphen ranges, ||", () => {
    // juliangruber/brace-expansion's repository advisories, verbatim.
    const brace = "< 1.1.19, >= 2.0.0 < 2.1.5, >= 3.0.0 < 3.0.7, >= 4.0.0 < 5.0.10";
    expect(inAdvisoryRange(npm, brace, "5.0.9")).toBe(true);
    expect(inAdvisoryRange(npm, brace, "5.0.10")).toBe(false);
    expect(inAdvisoryRange(npm, brace, "1.1.18")).toBe(true);
    expect(inAdvisoryRange(npm, brace, "1.1.19")).toBe(false);
    expect(inAdvisoryRange(npm, brace, "2.1.5")).toBe(false);
    const hyphen = "<1.1.17, >= 2.0.0 < 2.1.3, >= 3.0.0 < 3.0.3, 4.0.0 - 5.0.7";
    expect(inAdvisoryRange(npm, hyphen, "5.0.7")).toBe(true);
    expect(inAdvisoryRange(npm, hyphen, "5.0.8")).toBe(false);
    const mixed = ">= 3.0.0, < 5.0.7, >= 2.0.0, < 2.1.2, < 1.1.16";
    expect(inAdvisoryRange(npm, mixed, "2.1.1")).toBe(true);
    expect(inAdvisoryRange(npm, mixed, "2.5.0")).toBe(false);
    expect(inAdvisoryRange(npm, ">=5.0.0 <5.0.6 || >=6.0.0 <6.0.1", "6.0.0")).toBe(true);
    // isaacs/node-tar, isaacs/minimatch, fastify/fast-uri and aws/aws-cdk, verbatim.
    const tar = "6 <=6.1.8 || 5 <=5.0.9 || <=4.4.17";
    expect(inAdvisoryRange(npm, tar, "6.1.8")).toBe(true);
    expect(inAdvisoryRange(npm, tar, "6.1.9")).toBe(false);
    expect(inAdvisoryRange(npm, tar, "7.5.22")).toBe(false);
    expect(inAdvisoryRange(npm, tar, "4.4.17")).toBe(true);
    expect(inAdvisoryRange(npm, "10 <10.2.1 || 3 <3.1.3 || 9 <9.0.6", "10.2.5")).toBe(false);
    expect(inAdvisoryRange(npm, "10 <10.2.1 || 3 <3.1.3 || 9 <9.0.6", "10.2.0")).toBe(true);
    expect(inAdvisoryRange(npm, "4.0.0 < 4.1.2; 3.0.0 < 3.1.5; < 2.4.4", "3.1.8")).toBe(false);
    expect(inAdvisoryRange(npm, "4.0.0 < 4.1.2; 3.0.0 < 3.1.5; < 2.4.4", "3.1.4")).toBe(true);
    expect(inAdvisoryRange(npm, "<= 2.4.0; v3.0.0 <= 3.1.1", "3.1.8")).toBe(false);
    expect(inAdvisoryRange(npm, "<= 2.4.0; v3.0.0 <= 3.1.1", "2.5.0")).toBe(false);
    expect(inAdvisoryRange(npm, ">=2.0.0;<2.80.0", "2.271.0")).toBe(false);
    expect(inAdvisoryRange(npm, "6", "6.9.0")).toBe(true);
    expect(inAdvisoryRange(npm, "6", "7.0.0")).toBe(false);
    expect(inAdvisoryRange(maven, "1.1", "1.1.0")).toBe(true);
    const xRanges = "<3.2.3 || 4.x <4.4.15 || 5.x <5.0.7 || 6.x <6.1.2";
    expect(inAdvisoryRange(npm, xRanges, "7.5.22")).toBe(false);
    expect(inAdvisoryRange(npm, xRanges, "5.0.6")).toBe(true);
    expect(inAdvisoryRange(npm, "<=2.4.0; 3.0.0<= 3.1.0", "3.1.0")).toBe(true);
    expect(inAdvisoryRange(npm, "<=2.4.0; 3.0.0<= 3.1.0", "3.1.8")).toBe(false);
    expect(inAdvisoryRange(npm, "≤ 3.4.1 ", "3.4.4")).toBe(false);
    // google/guava's GHSA-xxph-c9ww-hj94, verbatim (an en dash).
    expect(inAdvisoryRange(maven, "4.0–33.7.1", "33.7.1-jre")).toBe(true);
    expect(inAdvisoryRange(maven, "4.0–33.7.1", "33.7.2-jre")).toBe(false);
    expect(inAdvisoryRange(npm, "≥ 3.0.0, ≤ 3.4.1", "3.4.1")).toBe(true);
    // netty/netty's GHSA-4g8c-wm8x-jfhw, verbatim (`=<`).
    expect(inAdvisoryRange(maven, "4.1.91.Final =< 4.1.117.Final", "4.1.117.Final")).toBe(true);
    expect(inAdvisoryRange(maven, "4.1.91.Final =< 4.1.117.Final", "4.1.138.Final")).toBe(false);
    expect(inAdvisoryRange(npm, "=> 2.0.0, < 2.1.0", "2.0.5")).toBe(true);
  });

  it("keeps `||` a hard boundary and reads an inverted interval as both open ends", () => {
    expect(inAdvisoryRange(npm, ">=2.0.0 || <1.0.0", "2.1.0")).toBe(true);
    expect(inAdvisoryRange(npm, ">=2.0.0 || <1.0.0", "0.5.0")).toBe(true);
    expect(inAdvisoryRange(npm, ">=2.0.0 || <1.0.0", "1.5.0")).toBe(false);
    expect(inAdvisoryRange(npm, ">= 2.0.0, < 1.0.0", "0.5.0")).toBe(true);
    expect(inAdvisoryRange(npm, ">= 2.0.0, < 1.0.0", "2.5.0")).toBe(true);
    expect(inAdvisoryRange(npm, ">= 2.0.0, < 1.0.0", "1.5.0")).toBe(false);
    expect(inAdvisoryRange(npm, "<1.0.0 ||", "0.5.0")).toBeUndefined();
  });

  it("returns undefined for what it can't read", () => {
    expect(inAdvisoryRange(npm, "", "1.0.0")).toBeUndefined();
    expect(inAdvisoryRange(npm, "~> 1.2", "1.0.0")).toBeUndefined();
    expect(inAdvisoryRange(npm, "< 2.245.0 (on Windows, < 2.246.0)", "1.0.0")).toBeUndefined();
    expect(inAdvisoryRange(npm, "< 1.2", "1.0.0")).toBeUndefined();
    expect(inAdvisoryRange(npm, "all versions", "1.0.0")).toBeUndefined();
  });
});
