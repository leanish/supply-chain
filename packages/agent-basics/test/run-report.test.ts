import { describe, expect, it } from "vitest";

import { RunReport, type RunFinished } from "../src/report/run-report.ts";
import { unreportedSkillUsage, toSkillUsageRecord } from "../src/usage/skill-usage-record.ts";

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
