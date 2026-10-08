import { describe, expect, it } from "vitest";

import { staleScanStatus } from "../src/stale-scan.ts";

const GATE = [{ path: "leanish/supply-chain/.github/workflows/supply-chain.yml@abc123" }];

const NOW = new Date("2026-10-07T12:00:00Z");

function answering(status: number, body: unknown, seen: string[] = []): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
}

describe("staleScanStatus", () => {
  it("is fresh within the margin and stale past it, reading scheduled successes that call the reusable gate", async () => {
    const seen: string[] = [];
    const fresh = await staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(200, { workflow_runs: [{ referenced_workflows: GATE, run_started_at: "2026-10-07T05:17:00Z" }] }, seen));
    expect(fresh).toEqual({ stale: false, lastSuccess: "2026-10-07T05:17:00Z", detail: "the last successful scheduled scan of main ran 6 hours ago" });
    expect(seen[0]).toBe("https://api.github.com/repos/leanish/widget/actions/runs?branch=main&event=schedule&status=success&per_page=100&page=1");
    const old = await staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(200, { workflow_runs: [{ referenced_workflows: GATE, run_started_at: "2026-10-05T05:17:00Z" }] }));
    expect(old).toMatchObject({ stale: true, detail: "the last successful scheduled scan of main ran 54 hours ago (more than 36)" });
  });

  it("is stale with no workflow or no success, and fails on other errors", async () => {
    await expect(staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(404, {}))).rejects.toThrow("HTTP 404");
    expect(await staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(200, { workflow_runs: [] }))).toMatchObject({ stale: true, detail: "no scheduled supply-chain run on main has succeeded yet" });
    await expect(staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(500, {}))).rejects.toThrow("HTTP 500");
  });
  it("recognises a ci.yml caller and ignores newer unrelated scheduled successes", async () => {
    const runs = [
      { path: ".github/workflows/nightly.yml", run_started_at: "2026-10-07T11:00:00Z" },
      { path: ".github/workflows/ci.yml", referenced_workflows: GATE, run_started_at: "2026-10-07T05:17:00Z" },
    ];
    expect(await staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(200, { workflow_runs: runs }))).toMatchObject({ stale: false, lastSuccess: "2026-10-07T05:17:00Z" });
    expect(await staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(200, { workflow_runs: [runs[0]] }))).toMatchObject({ stale: true });
  });

  it("paginates past unrelated schedules and rejects invalid timestamps", async () => {
    const seen: string[] = [];
    const fetch = (async (url) => {
      seen.push(String(url));
      const runs = seen.length === 1 ? Array.from({ length: 100 }, () => ({ created_at: "2026-10-07" })) : [{ referenced_workflows: GATE, created_at: "2026-10-07T05:17:00Z" }];
      return new Response(JSON.stringify({ workflow_runs: runs }));
    }) as typeof globalThis.fetch;
    expect(await staleScanStatus("leanish/widget", "main", "t", NOW, 36, fetch)).toMatchObject({ stale: false });
    expect(seen[1]).toContain("page=2");
    await expect(staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(200, { workflow_runs: [{ referenced_workflows: GATE, run_started_at: "invalid" }] }))).rejects.toThrow("invalid scheduled scan time");
  });

});
