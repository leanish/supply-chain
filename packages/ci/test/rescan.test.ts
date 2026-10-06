import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_RESCANNED_PRS, parsePlan, planRescan, publishRescan, readVerdicts, type RescanVerdict, verdictSummary } from "../src/rescan.ts";
import { fakeFetch, type FakeResponse } from "./fake-fetch.ts";

const API = "https://api.github.com/repos/acme/app";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const STARTED = new Date("2026-10-07T04:23:00Z");
const pr = { number: 7, head: HEAD, base: BASE, baseRef: "main" };

/** GitHub as the publisher sees it: PR 7 open on `main`, main at BASE, `statuses` already on HEAD; records POSTs. */
function github(overrides: Record<string, FakeResponse> = {}, posts: Array<{ url: string; body: unknown }> = []) {
  const routes: Record<string, FakeResponse | ((init?: { body?: string }) => FakeResponse)> = {
    [`${API}/pulls/7`]: { body: { state: "open", head: { sha: HEAD }, base: { ref: "main" } } },
    [`${API}/branches/main`]: { body: { commit: { sha: BASE } } },
    [`${API}/commits/${HEAD}/statuses?per_page=100`]: { body: [] },
    [`${API}/statuses/${HEAD}`]: (init) => {
      posts.push({ url: `${API}/statuses/${HEAD}`, body: JSON.parse(init?.body ?? "{}") });
      return { status: 201, body: {} };
    },
    ...overrides,
  };
  return fakeFetch(routes);
}

const verdict = (overrides: Partial<RescanVerdict> = {}): RescanVerdict => ({
  number: 7,
  head: HEAD,
  base: BASE,
  completed: true,
  verdict: "fail",
  summary: "1 failure(s): new: lib@1.0.0: GHSA-x has no exception",
  ...overrides,
});

async function publish(verdicts: Map<number, RescanVerdict>, fetch: ReturnType<typeof github>) {
  const log: string[] = [];
  const posted = await publishRescan([pr], verdicts, {
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

describe("rescan publisher", () => {
  it("posts the verdict as a status on the PR head, under the required check's name", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    expect((await publish(new Map([[7, verdict()]]), github({}, posts))).posted).toBe(1);
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
    await publish(new Map([[7, verdict({ verdict: "pass", summary: "clean" })]]), github({}, passed));
    expect(passed[0]!.body).toMatchObject({ state: "success", description: "Daily rescan: clean" });
  });

  it("posts a failure when the rescan left no verdict, or one for another head or base", async () => {
    for (const verdicts of [new Map(), new Map([[7, verdict({ verdict: "pass", base: "c".repeat(40) })]])]) {
      const posts: Array<{ url: string; body: unknown }> = [];
      await publish(verdicts, github({}, posts));
      expect(posts[0]!.body).toMatchObject({ state: "failure", description: "Daily rescan didn't complete" });
    }
    const incomplete: Array<{ url: string; body: unknown }> = [];
    await publish(new Map([[7, verdict({ completed: false, verdict: "fail" })]]), github({}, incomplete));
    expect(incomplete[0]!.body).toMatchObject({ state: "failure", description: "Daily rescan didn't complete" });
  });

  it("skips a PR that closed, moved its head or base, or got a newer status", async () => {
    const cases: Array<[Record<string, FakeResponse>, string]> = [
      [{ [`${API}/pulls/7`]: { body: { state: "closed", head: { sha: HEAD }, base: { ref: "main" } } } }, "closed or changed"],
      [{ [`${API}/pulls/7`]: { body: { state: "open", head: { sha: "d".repeat(40) }, base: { ref: "main" } } } }, "closed or changed"],
      [{ [`${API}/branches/main`]: { body: { commit: { sha: "e".repeat(40) } } } }, "main moved"],
      [
        {
          [`${API}/commits/${HEAD}/statuses?per_page=100`]: {
            body: [{ context: "supply-chain / supply-chain", created_at: "2026-10-07T05:00:00Z", state: "success" }],
          },
        },
        "a newer supply-chain / supply-chain status exists",
      ],
    ];
    for (const [overrides, reason] of cases) {
      const posts: Array<{ url: string; body: unknown }> = [];
      const { posted, log } = await publish(new Map([[7, verdict()]]), github(overrides, posts));
      expect(posted).toBe(0);
      expect(posts).toEqual([]);
      expect(log.join("\n")).toContain(reason);
    }
  });

  it("fails closed when GitHub doesn't answer", async () => {
    await expect(publish(new Map([[7, verdict()]]), github({ [`${API}/pulls/7`]: { status: 502 } }))).rejects.toThrow("HTTP 502");
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

  it("reads verdict files, ignoring what doesn't parse, and summarizes reports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supply-chain-verdicts-"));
    try {
      await writeFile(join(dir, "verdict-7.json"), JSON.stringify(verdict()));
      await writeFile(join(dir, "verdict-8.json"), "not json");
      await writeFile(join(dir, "verdict-9.json"), JSON.stringify({ number: 9 }));
      expect([...(await readVerdicts(dir)).keys()]).toEqual([7]);
      expect((await readVerdicts(join(dir, "missing"))).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(verdictSummary({ completed: true, verdict: "pass", failures: [], warnings: [] })).toBe("clean");
    expect(verdictSummary({ completed: true, verdict: "pass", failures: [], warnings: ["a", "b"] })).toBe("pass, 2 inherited warning(s)");
    expect(verdictSummary({ completed: false, verdict: "fail", failures: [], warnings: [] })).toBe("didn't complete");
  });
});
