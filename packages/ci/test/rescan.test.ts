import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_RESCANNED_PRS, parsePlan, planRescan, type RescanOutcome, type RescanSteps, runRescan, verdictSummary } from "../src/rescan.ts";
import { fakeFetch, type FakeResponse } from "./fake-fetch.ts";

const API = "https://api.github.com/repos/acme/app";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "c".repeat(40);
const STARTED = new Date("2026-10-07T04:23:00Z");
const pr = { number: 7, head: HEAD, base: BASE, baseRef: "main" };

/** GitHub as the rescan sees it: PR 7 open on `main`, main at BASE, no statuses on HEAD; records POSTs. */
function github(overrides: Record<string, FakeResponse> = {}, posts: Array<{ url: string; body: unknown }> = []) {
  return fakeFetch({
    [`${API}/pulls/7`]: { body: { state: "open", head: { sha: HEAD }, base: { ref: "main" } } },
    [`${API}/branches/main`]: { body: { commit: { sha: BASE } } },
    [`${API}/commits/${HEAD}/statuses?per_page=100&page=1`]: { body: [] },
    [`${API}/statuses/${HEAD}`]: (init) => {
      posts.push({ url: `${API}/statuses/${HEAD}`, body: JSON.parse(init?.body ?? "{}") });
      return { status: 201, body: {} };
    },
    ...overrides,
  });
}

let inventories: string;
beforeEach(async () => {
  inventories = await mkdtemp(join(tmpdir(), "supply-chain-rescan-"));
});
afterEach(async () => {
  await rm(inventories, { recursive: true, force: true });
});

/** The inventory job's artifacts for PR 7: `done` markers, and gradle.json on the given sides. */
async function inventory(sides: Array<"base" | "head">, gradle: Array<"base" | "head"> = []) {
  for (const side of sides) {
    const dir = join(inventories, `rescan-inventory-7-${side}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "done"), "");
    if (gradle.includes(side)) await writeFile(join(dir, "gradle.json"), "{}");
  }
}

function steps(outcome: RescanOutcome | Error, signatures: string[] = [], calls: string[] = [], recorded: string[] = []): RescanSteps {
  return {
    record: async (recordedPr, result) => {
      const pair = result.compared === undefined ? "" : ` ${result.compared.base.slice(0, 1)}..${result.compared.head.slice(0, 1)}`;
      recorded.push(`#${recordedPr.number} ${result.state}${pair} ${result.description}`);
    },
    prepare: async () => {
      calls.push("prepare");
      return { base: BASE, head: MERGE };
    },
    compare: async (base, head, gradle) => {
      calls.push(`compare ${base.slice(0, 1)}..${head.slice(0, 1)} ${gradle.base === undefined ? "-" : "g"}${gradle.head === undefined ? "-" : "g"}`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    signatures: async () => {
      calls.push("signatures");
      return signatures;
    },
    reset: async () => {
      calls.push("reset");
    },
  };
}

const pass: RescanOutcome = { osvScannerVersion: "2.6.0", configDigest: "default", completed: true, verdict: "pass", failures: [], warnings: [], gaps: [], notes: [] };
const fail: RescanOutcome = { osvScannerVersion: "2.6.0", configDigest: "default", completed: true, verdict: "fail", failures: ["new: lib@1.0.0: GHSA-x has no exception"], warnings: [], gaps: [], notes: [] };

async function rescan(rescanSteps: RescanSteps, fetch: ReturnType<typeof github>) {
  const log: string[] = [];
  const posted = await runRescan([pr], inventories, rescanSteps, {
    fetch,
    token: "t",
    repository: "acme/app",
    context: "supply-chain / supply-chain",
    startedAt: STARTED,
    targetUrl: "https://github.com/acme/app/actions/runs/1",
    log: (line) => log.push(line),
  });
  return { posted, log };
}

describe("rescan", () => {
  it("merges, compares with the PR's inventories, checks signatures, and posts the verdict on the PR head", async () => {
    await inventory(["base", "head"], ["head"]);
    const posts: Array<{ url: string; body: unknown }> = [];
    const calls: string[] = [];
    expect((await rescan(steps(fail, [], calls), github({}, posts))).posted).toBe(1);
    expect(calls).toEqual(["prepare", "compare b..c -g", "reset"]);
    expect(posts).toEqual([
      {
        url: `${API}/statuses/${HEAD}`,
        body: {
          state: "failure",
          context: "supply-chain / supply-chain",
          description: "Daily rescan: 1 failure(s): new: lib@1.0.0: GHSA-x has no exception",
          target_url: "https://github.com/acme/app/actions/runs/1",
        },
      },
    ]);
    const passed: Array<{ url: string; body: unknown }> = [];
    const passingCalls: string[] = [];
    await rescan(steps(pass, [], passingCalls), github({}, passed));
    expect(passingCalls).toEqual(["prepare", "compare b..c -g", "signatures", "reset"]);
    expect(passed[0]!.body).toMatchObject({ state: "success", description: "Daily rescan: clean" });
  });

  it("says a pass came with inherited findings or coverage gaps, and records every PR's result", async () => {
    await inventory(["base", "head"]);
    const posts: Array<{ url: string; body: unknown }> = [];
    const recorded: string[] = [];
    await rescan(steps({ ...pass, warnings: ["inherited: x"], gaps: ["no repo for y", "no repo for z"] }, [], [], recorded), github({}, posts));
    expect(posts[0]!.body).toMatchObject({ state: "success", description: "Daily rescan: pass, 1 inherited finding(s), 2 coverage gap(s)" });
    // The merged pair the gate checked, not the PR's own base and head.
    expect(recorded).toEqual(["#7 success b..c Daily rescan: pass, 1 inherited finding(s), 2 coverage gap(s)"]);
  });

  it("checks the PR again right before posting, in case it moved during the scan", async () => {
    await inventory(["base", "head"]);
    let reads = 0;
    const posts: Array<{ url: string; body: unknown }> = [];
    const moving = github(
      {
        [`${API}/pulls/7`]: {},
      },
      posts,
    );
    const fetch: typeof moving = async (url, init) => {
      if (url === `${API}/pulls/7`) {
        reads++;
        const head = reads === 1 ? HEAD : "f".repeat(40);
        const body = { state: "open", head: { sha: head }, base: { ref: "main" } };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
      }
      return moving(url, init);
    };
    const { posted, log } = await rescan(steps(fail), fetch);
    expect(reads).toBe(2);
    expect(posted).toBe(0);
    expect(posts).toEqual([]);
    expect(log.join("\n")).toContain("closed or changed");
  });

  it("fails on npm signature problems even when the comparison passes", async () => {
    await inventory(["base", "head"]);
    const posts: Array<{ url: string; body: unknown }> = [];
    await rescan(steps(pass, ["npm audit signatures in . failed: 1 package has an invalid signature"]), github({}, posts));
    expect(posts[0]!.body).toMatchObject({
      state: "failure",
      description: "Daily rescan: 1 failure(s): npm audit signatures in . failed: 1 package has an invalid signature",
    });
  });

  it("never runs npm after comparison rejects dependency sources", async () => {
    await inventory(["base", "head"]);
    const calls: string[] = [];
    const posts: Array<{ url: string; body: unknown }> = [];
    const rejected = { ...fail, failures: ["evil doesn't come from an allowed registry: git+https://example.invalid/evil.git"] };
    await rescan(steps(rejected, [], calls), github({}, posts));
    expect(calls).toEqual(["prepare", "compare b..c --", "reset"]);
    expect(posts[0]!.body).toMatchObject({ state: "failure" });
  });

  it("posts a failure when an inventory side didn't complete, or the comparison throws", async () => {
    await inventory(["base"]);
    const missing: Array<{ url: string; body: unknown }> = [];
    const calls: string[] = [];
    const recorded: string[] = [];
    await rescan(steps(pass, [], calls, recorded), github({}, missing));
    expect(missing[0]!.body).toMatchObject({ state: "failure", description: "Daily rescan didn't complete: the head inventory didn't complete" });
    expect(calls).toEqual(["reset"]);
    expect(recorded).toEqual(["#7 failure Daily rescan didn't complete: the head inventory didn't complete"]);
    await inventory(["head"]);
    const thrown: Array<{ url: string; body: unknown }> = [];
    await rescan(steps(new Error("OSV is down")), github({}, thrown));
    expect(thrown[0]!.body).toMatchObject({ state: "failure", description: "Daily rescan didn't complete: OSV is down" });
  });

  it("skips a PR that closed, moved its head or base, or got a newer status, reading every page of statuses", async () => {
    await inventory(["base", "head"]);
    const old = Array.from({ length: 100 }, () => ({ context: "other", created_at: "2026-10-07T05:00:00Z" }));
    const cases: Array<[Record<string, FakeResponse>, string]> = [
      [{ [`${API}/pulls/7`]: { body: { state: "closed", head: { sha: HEAD }, base: { ref: "main" } } } }, "closed or changed"],
      [{ [`${API}/pulls/7`]: { body: { state: "open", head: { sha: "d".repeat(40) }, base: { ref: "main" } } } }, "closed or changed"],
      [{ [`${API}/branches/main`]: { body: { commit: { sha: "e".repeat(40) } } } }, "main moved"],
      [
        {
          [`${API}/commits/${HEAD}/statuses?per_page=100&page=1`]: { body: old },
          [`${API}/commits/${HEAD}/statuses?per_page=100&page=2`]: {
            body: [{ context: "supply-chain / supply-chain", created_at: "2026-10-07T04:30:00Z", state: "success" }],
          },
        },
        "a newer supply-chain / supply-chain status exists",
      ],
    ];
    for (const [overrides, reason] of cases) {
      const posts: Array<{ url: string; body: unknown }> = [];
      const { posted, log } = await rescan(steps(fail), github(overrides, posts));
      expect(posted).toBe(0);
      expect(posts).toEqual([]);
      expect(log.join("\n")).toContain(reason);
    }
  });

  it("stops reading statuses at the first one older than the rescan", async () => {
    await inventory(["base", "head"]);
    const posts: Array<{ url: string; body: unknown }> = [];
    const statuses = { body: [{ context: "supply-chain / supply-chain", created_at: "2026-10-06T04:30:00Z", state: "success" }] };
    await rescan(steps(fail), github({ [`${API}/commits/${HEAD}/statuses?per_page=100&page=1`]: statuses }, posts));
    expect(posts).toHaveLength(1);
  });

  it("fails closed when GitHub doesn't answer", async () => {
    await expect(rescan(steps(pass), github({ [`${API}/pulls/7`]: { status: 502 } }))).rejects.toThrow("HTTP 502");
  });
});

describe("rescan plan and verdicts", () => {
  it("lists open PRs with their base's tip, every page, and one PR when asked", async () => {
    const pulls = (n: number, start: number) =>
      Array.from({ length: n }, (_, i) => ({ number: start + i, head: { sha: HEAD }, base: { ref: i % 2 === 0 ? "main" : "release" } }));
    const fetch = fakeFetch({
      [`${API}/pulls?state=open&per_page=100&page=1`]: { body: pulls(100, 1) },
      [`${API}/pulls?state=open&per_page=100&page=2`]: { body: pulls(3, 101) },
      [`${API}/branches/main`]: { body: { commit: { sha: BASE } } },
      [`${API}/branches/release`]: { body: { commit: { sha: "c".repeat(40) } } },
      [`${API}/pulls/5`]: { body: { state: "open", number: 5, head: { sha: HEAD }, base: { ref: "main" } } },
    });
    const plan = await planRescan({ fetch, token: "t", repository: "acme/app" }, undefined);
    expect(plan).toHaveLength(103);
    expect(plan[1]).toEqual({ number: 2, head: HEAD, base: "c".repeat(40), baseRef: "release" });
    expect(await planRescan({ fetch, token: "t", repository: "acme/app" }, 5)).toEqual([{ number: 5, head: HEAD, base: BASE, baseRef: "main" }]);
  });

  it("refuses more PRs than a matrix holds, and malformed entries", () => {
    const many = Array.from({ length: MAX_RESCANNED_PRS + 1 }, (_, i) => ({ ...pr, number: i + 1 }));
    expect(() => parsePlan(many)).toThrow(`${MAX_RESCANNED_PRS + 1} open PRs: the rescan handles at most ${MAX_RESCANNED_PRS}`);
    expect(() => parsePlan([{ ...pr, head: "short" }])).toThrow("malformed entry");
  });

  it("summarizes outcomes for the status description", () => {
    expect(verdictSummary({ completed: true, verdict: "pass", failures: [], warnings: [] })).toBe("clean");
    expect(verdictSummary({ completed: true, verdict: "pass", failures: [], warnings: ["a", "b"] })).toBe("pass, 2 inherited finding(s)");
    expect(verdictSummary({ completed: false, verdict: "fail", failures: [], warnings: [] })).toBe("didn't complete");
  });
});

describe("tool environments", () => {
  it("keep no credentials", async () => {
    const { withoutCredentials } = await import("../src/process.ts");
    expect(
      withoutCredentials({ PATH: "/bin", GITHUB_TOKEN: "a", GH_TOKEN: "b", GIT_FETCH_TOKEN: "c", ACTIONS_RUNTIME_TOKEN: "d", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "e" }),
    ).toEqual({ PATH: "/bin" });
  });
});
