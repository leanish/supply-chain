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
      readonly steps: ReadonlyArray<{ readonly run: string; readonly env: { readonly GATE_RESULT: string } }>;
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
    expect(step.env.GATE_RESULT).toBe("${{ needs.gate.result }}");
  });

  it.each([
    { result: "success", status: 0 },
    { result: "failure", status: 1 },
    { result: "skipped", status: 1 },
    { result: "cancelled", status: 1 },
    { result: "unknown", status: 1 },
    { result: "", status: 1 },
  ])("gate $result gives check exit $status", ({ result, status }) => {
    const command = spawnSync("/bin/bash", ["-e", "-c", step.run], {
      env: { GATE_RESULT: result },
      encoding: "utf8",
    });
    expect(command.error).toBeUndefined();
    expect(command.status).toBe(status);
  });
});
