import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fetchRepositoryAdvisories, type RepositoryAdvisory } from "../../ci/src/repository-advisories.ts";
import { gradleAdvisoryAffects } from "../src/gradle-advisories.ts";

const advisory = (range: string | undefined, patched?: string): RepositoryAdvisory => ({
  ghsaId: "GHSA-fixture", cveId: undefined, summary: undefined, severity: undefined, cweIds: [],
  vulnerabilities: [{ ecosystem: "java", name: "Gradle", range, patched }],
});

describe("Gradle advisory ranges", () => {
  it.each([
    ["8.14.3", true], ["8.14.4", false], ["8.15", false], ["9.0", true],
    ["9.2.1", true], ["9.2.2", false], ["9.3", false], ["10.0", false],
  ])("reads GHSA-mqwm-5m85-gmcv's union at %s", (version, expected) => {
    expect(gradleAdvisoryAffects(advisory("< 8.14.4, 9.0.0 to 9.2.1", "8.14.4, >= 9.3.0"), version)).toBe(expected);
  });
  it.each([
    ["7.6", true], ["7.6.1", false], ["8.0", true], ["8.1.1", true], ["8.1.2", false], ["8.2", false],
  ])("reads GHSA-2h6c-rv6q-494v's closed interval at %s", (version, expected) => {
    expect(gradleAdvisoryAffects(advisory("<7.6.1, [8.0,8.1.1]", "7.6.2, 8.2"), version)).toBe(expected);
  });
  it.each([
    ["4.4", false], ["4.5", true], ["6.4", true], ["6.4.99", true], ["6.5", false],
  ])("reads GHSA-ww7h-4fx5-8c2j's wildcard upper line at %s", (version, expected) => {
    expect(gradleAdvisoryAffects(advisory("4.5 through 6.4.x", "6.5"), version)).toBe(expected);
  });
  it.each([
    ["7.6.2", true], ["7.6.3", false], ["7.6.4", false], ["8.0", true], ["8.3", true], ["8.4", false],
  ])("honors GHSA-43r3-pqhv-f7h9's maintenance fixes at %s", (version, expected) => {
    expect(gradleAdvisoryAffects(advisory("<7.6.3, <8.4", "7.6.3, 8.4"), version)).toBe(expected);
  });
  it("honors a backport inside a bounded interval without treating that fix as applying to a later major", () => {
    const found = advisory("6.2 to 7.6", "6.9.4, 7.6.1, 8.0");
    expect(gradleAdvisoryAffects(found, "6.9.3")).toBe(true);
    expect(gradleAdvisoryAffects(found, "6.9.4")).toBe(false);
    expect(gradleAdvisoryAffects(found, "7.0")).toBe(true);
    expect(gradleAdvisoryAffects(found, "7.6")).toBe(true);
    expect(gradleAdvisoryAffects(found, "7.6.1")).toBe(false);
  });
  it("keeps bracket endpoint inclusivity, exact versions and single open-ended patches", () => {
    expect(gradleAdvisoryAffects(advisory("(8.0,8.2]"), "8.0")).toBe(false);
    expect(gradleAdvisoryAffects(advisory("[8.0,8.2)"), "8.2")).toBe(false);
    expect(gradleAdvisoryAffects(advisory("8.12", "8.12.1"), "8.12")).toBe(true);
    expect(gradleAdvisoryAffects(advisory("8.12", "8.12.1"), "8.12.1")).toBe(false);
    expect(gradleAdvisoryAffects(advisory(">=8.0", "8.1"), "9.0")).toBe(false);
  });
  it.each([undefined, "unknown", "8.0 to someday", "[8.0,unknown]", ">=8.bogus", "4.5 through 6.4.x.x"])("rejects genuinely unreadable ranges %s", (range) => {
    expect(() => gradleAdvisoryAffects(advisory(range), "9.0")).toThrow("unreadable Gradle advisory range");
  });
  it("reads every vulnerability, and rejects an unreadable patch when it is needed", () => {
    const found = advisory(">=8.0");
    expect(() => gradleAdvisoryAffects({ ...found, vulnerabilities: [...found.vulnerabilities, ...advisory("unknown").vulnerabilities] }, "9.0")).toThrow("unreadable");
    expect(() => gradleAdvisoryAffects(advisory(">=8.0", "maybe"), "9.0")).toThrow("unreadable Gradle patched version");
  });
  it("reads every published Gradle advisory's real range across the historical and current majors", async () => {
    // Public GET /repos/gradle/gradle/security-advisories, fetched 2026-10-07; descriptions omitted from the fixture.
    const entries = JSON.parse(readFileSync(new URL("./fixtures/gradle-advisories.json", import.meta.url), "utf8"));
    const found = await fetchRepositoryAdvisories("gradle/gradle", { token: undefined, fetch: async () => ({
      ok: true, status: 200, headers: { get: () => null }, json: async () => entries, text: async () => "",
    }) });
    expect(found).toHaveLength(18);
    for (const entry of found!) {
      for (const version of ["1.0", "4.5", "6.4.99", "6.9.4", "7.6.3", "8.12", "8.14.4", "9.2.1", "9.8.0", "10.0"]) {
        expect(typeof gradleAdvisoryAffects(entry, version), `${entry.ghsaId}@${version}`).toBe("boolean");
      }
    }
  });
});
