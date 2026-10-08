import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SkillLoader } from "../../agent-basics/src/skill/skill-loader.ts";
import type { Fetch } from "../../ci/src/http.ts";
import { npmWindowFor } from "../src/npm-window.ts";
import type { ChangePlan } from "../src/plan.ts";

const NOW = new Date("2026-10-07T12:00:00Z");

function plan(...targets: Array<[string, string]>): ChangePlan {
  return { topic: "malware", malware: true, packages: targets.map(([name]) => `npm|${name}`), severity: "HIGH",
    moves: targets.map(([name, to]) => ({ ecosystem: "npm", name, from: "1.0.0", to, mechanism: "npm-lock",
      locations: [`node_modules/${name}`], advisories: [], major: false, commitSha: undefined, declaredAs: undefined })) };
}

function registry(times: Record<string, unknown>): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  return { calls, fetch: async (url) => {
    calls.push(url);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: times, versions: {} }), text: async () => "" };
  } };
}

describe("secure-it npm window", () => {
  it("exempts unrelated young or unreadable base copies only in the affected lockfile", async () => {
    const source = registry({ "1.0.0": "2026-10-06T00:00:00Z", "1.0.1": "2026-01-01T00:00:00Z" });
    const locks = new Map([
      ["package-lock.json", { lockfileVersion: 3, packages: { "": {}, "node_modules/lib": { version: "1.0.0" }, "node_modules/unrelated": { version: "1.0.0" }, "node_modules/unreadable": { version: "0.1.0" } } }],
      ["tools/package-lock.json", { lockfileVersion: 3, packages: { "": {}, "node_modules/outside": { version: "1.0.0" } } }],
    ]);
    const result = await npmWindowFor(plan(["lib", "1.0.1"]), 7, [], NOW, source.fetch, locks);
    expect(result.exclude).toEqual(["lib", "unreadable", "unrelated"]);
    expect(result.notes).toContainEqual(expect.stringContaining("unrelated: npm's window excludes its locked 1.0.0"));
    expect(result.notes).toContainEqual(expect.stringContaining("unreadable: npm's window excludes its locked 0.1.0 because its publish time could not be read"));
    expect(source.calls).toHaveLength(3);
  });
  it("exempts young targets only, retains own scopes, and reads each package once", async () => {
    const source = registry({ "1.2.2": "2026-09-30T12:00:01Z", "1.2.1": "2026-09-30T12:00:00Z" });
    const result = await npmWindowFor(plan(["source-map-js", "1.2.2"], ["source-map-js", "1.2.2"], ["old", "1.2.1"]), 7, ["@own/*"], NOW, source.fetch);
    expect(result.exclude).toEqual(["@own/*", "source-map-js"]);
    expect(result.notes).toEqual([expect.stringContaining("source-map-js@1.2.2")]);
    expect(source.calls).toHaveLength(2);
  });

  it("exempts an unreadable target with a note rather than silently blocking a chosen fix", async () => {
    const source = registry({ "1.2.2": "not-a-date" });
    expect(await npmWindowFor(plan(["lib", "1.2.2"]), 7, [], NOW, source.fetch)).toEqual({ exclude: ["lib"], notes: [expect.stringContaining("publish time could not be read")] });
    const unavailable: Fetch = async () => { throw new Error("offline"); };
    expect((await npmWindowFor(plan(["lib", "1.2.2"]), 7, [], NOW, unavailable)).exclude).toEqual(["lib"]);
  });

  it("does not query npm for non-npm plans or an age window of zero", async () => {
    const source = registry({});
    expect(await npmWindowFor({ ...plan(), moves: [] }, 7, [], NOW, source.fetch)).toEqual({ exclude: [], notes: [] });
    expect(await npmWindowFor(plan(["lib", "1.2.2"]), 0, [], NOW, source.fetch)).toEqual({ exclude: [], notes: [] });
    expect(source.calls).toEqual([]);
  });

  it("requires explicit exclusions in the strict skill schema", async () => {
    const skill = await new SkillLoader({ skillsDirs: [fileURLToPath(new URL("../skills", import.meta.url))] }).loadEntrypoint("secure-it");
    expect(skill.inputSchema).toMatchObject({ additionalProperties: false, required: expect.arrayContaining(["npmAgeExclusions"]),
      properties: { npmAgeExclusions: { type: "array", items: { type: "string" } } } });
  });
});
