// New in this repository; the signal cases are adapted from leanish/leanish-development
// core/runtime/test/unit/run-local-cli.test.ts at e4f8a1e (see PROVENANCE.md).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RunReport, type RunFinished } from "../src/report/run-report.ts";
import { unreportedSkillUsage, toSkillUsageRecord } from "../src/usage/skill-usage-record.ts";

const SIGNALLED = fileURLToPath(new URL("./fixtures/report-on-signal.ts", import.meta.url));

/** Runs the fixture until it's ready, sends `signal`, and returns how it died and its final lines. */
async function killed(signal: NodeJS.Signals, mode: "idle" | "in-flight"): Promise<{ signal: NodeJS.Signals | null; finals: RunFinished[] }> {
  const child = spawn(process.execPath, [SIGNALLED, mode], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const ready = new Promise<void>((done) =>
    child.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString("utf8");
      if (log.includes("ready\n")) done();
    }),
  );
  const exited = new Promise<NodeJS.Signals | null>((done) => child.on("exit", (_code, died) => done(died)));
  await ready;
  child.kill(signal);
  const died = await exited;
  const finals = log.split("\n").filter((line) => line.includes('"run finished"')).map((line) => JSON.parse(line) as RunFinished);
  return { signal: died, finals };
}

const CLOCK = () => "2026-10-07T05:00:00.000Z";

function parse(line: string | undefined): RunFinished {
  if (line === undefined) throw new Error("no line");
  expect(line.endsWith("\n")).toBe(true);
  return JSON.parse(line) as RunFinished;
}

describe("RunReport", () => {
  it("ends a command with one line: tool, repo, status, result and its skill runs", () => {
    const report = new RunReport(CLOCK);
    report.identified("secure-it", "acme/widget");
    report.usageRecorder.started?.({ invocationId: "i-1", entrypoint: "secure-it" });
    report.usageRecorder.record(
      toSkillUsageRecord(unreportedSkillUsage("codex", 12, "sol"), { invocationId: "i-1", entrypoint: "secure-it", outcome: "succeeded" }, { usd: null, complete: false, byModel: [], gaps: [] }),
    );
    const line = parse(report.finish({ status: "ok", exitCode: 0, result: { pullRequest: "https://github.com/acme/widget/pull/7" } }));
    expect(line).toMatchObject({
      ts: "2026-10-07T05:00:00.000Z",
      level: "info",
      msg: "run finished",
      tool: "secure-it",
      repo: "acme/widget",
      status: "ok",
      exitCode: 0,
      result: { pullRequest: "https://github.com/acme/widget/pull/7" },
    });
    expect(line.skills.map((skill) => skill.invocationId)).toEqual(["i-1"]);
    expect(line).not.toHaveProperty("dispatches");
  });

  it("writes the line once, and an error before the tool was identified has neither tool nor repo", () => {
    const report = new RunReport(CLOCK);
    const line = parse(report.finish({ status: "error", exitCode: 64, error: "usage: secure-it run <owner/repo>" }));
    expect(line).toMatchObject({ level: "error", status: "error", exitCode: 64, error: "usage: secure-it run <owner/repo>" });
    expect(line).not.toHaveProperty("tool");
    expect(line).not.toHaveProperty("result");
    expect(report.finish({ status: "ok", exitCode: 0 })).toBeUndefined();
  });
});

// The source's "writes the line before dying of SIGTERM" and "interrupted mid-skill" cases, on a bare command.
describe("reportOnTerminationSignals", () => {
  it("writes the line before dying of SIGTERM, with the signal's exit code and complete (empty) totals", async () => {
    const { signal, finals } = await killed("SIGTERM", "idle");
    expect(signal).toBe("SIGTERM");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      status: "interrupted",
      exitCode: 143,
      signal: "SIGTERM",
      error: "stopped by SIGTERM",
      tool: "secure-it",
      repo: "acme/widget",
      totals: { skillRuns: 0, skillRunsInProgress: 0, tokens: { total: 0 }, estimatedApiCostUsd: 0, gaps: [] },
    });
  }, 20_000);

  it("reports a skill run still in flight as unknown usage, with only lower bounds", async () => {
    const { signal, finals } = await killed("SIGINT", "in-flight");
    expect(signal).toBe("SIGINT");
    expect(finals).toEqual([
      expect.objectContaining({
        status: "interrupted",
        exitCode: 130,
        totals: expect.objectContaining({
          skillRuns: 0,
          skillRunsInProgress: 1,
          tokens: null,
          estimatedApiCostUsd: null,
          tokensLowerBound: expect.objectContaining({ total: 0 }),
          gaps: ["1 skill run(s) were still in progress, so their usage is unknown"],
        }),
      }),
    ]);
  }, 20_000);
});
