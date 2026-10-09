/** The compatibility check must fail when the reusable gate fails, skips or is cancelled. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface CompatibilityWorkflow {
  readonly jobs: {
    readonly gate: { readonly with: { readonly "required-check": string } };
    readonly "supply-chain": {
      readonly needs: string;
      readonly if: string;
      readonly steps: ReadonlyArray<{ readonly run: string; readonly env: Readonly<Record<string, string>> }>;
    };
  };
}

const workflow = parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")) as CompatibilityWorkflow;
const bridge = workflow.jobs["supply-chain"];
const step = bridge.steps[0]!;

describe("the existing required supply-chain check", () => {
  it("runs after every gate outcome and shares its context with daily rescans", () => {
    expect(bridge.needs).toBe("gate");
    expect(bridge.if).toBe("always()");
    expect(workflow.jobs.gate.with["required-check"]).toBe("supply-chain");
    expect(step.env).toEqual({
      GATE_RESULT: "${{ needs.gate.result }}",
      COMPARISON_PASSED: "${{ needs.gate.outputs.comparison-passed }}",
      COOLDOWN_HELD: "${{ needs.gate.outputs.cooldown-held }}",
    });
  });

  it.each([
    { result: "success", passed: "", held: "", status: 0 },
    { result: "failure", passed: "", held: "", status: 1 },
    { result: "skipped", passed: "", held: "", status: 1 },
    { result: "cancelled", passed: "", held: "", status: 1 },
    { result: "unknown", passed: "", held: "", status: 1 },
    { result: "", passed: "", held: "", status: 1 },
    // Only the cooldown failed: `gate / cooldown` reports the hold.
    { result: "failure", passed: "true", held: "true", status: 0 },
    // A broken cooldown evaluation, or a failing comparison, still fails.
    { result: "failure", passed: "true", held: "", status: 1 },
    { result: "failure", passed: "true", held: "false", status: 1 },
    { result: "failure", passed: "", held: "true", status: 1 },
  ])("gate $result (comparison passed '$passed', held '$held') gives check exit $status", ({ result, passed, held, status }) => {
    const command = spawnSync("/bin/bash", ["-e", "-c", step.run], {
      env: { GATE_RESULT: result, COMPARISON_PASSED: passed, COOLDOWN_HELD: held },
      encoding: "utf8",
    });
    expect(command.error).toBeUndefined();
    expect(command.status).toBe(status);
  });
});
