import { describe, expect, it } from "vitest";

import { staleScanStatus } from "../src/stale-scan.ts";

const NOW = new Date("2026-10-07T12:00:00Z");

function answering(status: number, body: unknown, seen: string[] = []): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
}

describe("staleScanStatus", () => {
  it("is fresh within the margin and stale past it, reading the scheduled successes of supply-chain.yml on the base", async () => {
    const seen: string[] = [];
    const fresh = await staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(200, { workflow_runs: [{ run_started_at: "2026-10-07T05:17:00Z" }] }, seen));
    expect(fresh).toEqual({ stale: false, lastSuccess: "2026-10-07T05:17:00Z", detail: "the last successful scheduled scan of main ran 6 hours ago" });
    expect(seen[0]).toBe("https://api.github.com/repos/leanish/widget/actions/workflows/supply-chain.yml/runs?branch=main&event=schedule&status=success&per_page=1");
    const old = await staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(200, { workflow_runs: [{ run_started_at: "2026-10-05T05:17:00Z" }] }));
    expect(old).toMatchObject({ stale: true, detail: "the last successful scheduled scan of main ran 54 hours ago (more than 36)" });
  });

  it("is stale with no workflow or no success, and fails on other errors", async () => {
    expect(await staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(404, {}))).toMatchObject({ stale: true, lastSuccess: undefined });
    expect(await staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(200, { workflow_runs: [] }))).toMatchObject({ stale: true, detail: "no scheduled supply-chain run on main has succeeded yet" });
    await expect(staleScanStatus("leanish/widget", "main", "t", NOW, 36, answering(500, {}))).rejects.toThrow("HTTP 500");
  });
});
