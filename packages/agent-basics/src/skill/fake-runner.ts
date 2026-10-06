// Copied from leanish/leanish-development core/runtime/src/skill/fake-runner.ts at e4f8a1e; see PROVENANCE.md.
import { performance } from "node:perf_hooks";

import { deliverSkillUsage, ZERO_TOKENS } from "../usage/skill-usage.ts";
import type {
  CodingAgentRunner,
  SkillInvocation,
  SkillInvocationResult,
} from "./runner.ts";
import { synthesizeFixture } from "./synthesize-fixture.ts";

/**
 * Test / local-dev runner that returns pre-canned responses keyed by
 * entrypoint name. Useful for runtime tests + integration tests that
 * don't want to spawn a real `claude` / `codex` subprocess.
 *
 * **Default behavior is strict.** If an entrypoint with no registered
 * response is invoked, the runner throws. This is the safer default for
 * downstream agent tests — a forgotten `runner.register(...)` becomes a
 * loud failure rather than a silent "fake-fixture" answer that passes
 * assertions on the happy path and masks the bug.
 *
 * Tests that want the smoke-test ergonomics (every declared entrypoint
 * answered with a synthesised schema-valid placeholder from
 * `outputSchema`) opt in with `{ synthesiseDefault: true }`. The
 * `agent-runtime run-local --fake-runner` CLI sets this on the runners
 * it constructs so the local smoke pipeline (`atc-dev-publish |
 * run-local --fake-runner`) keeps working without per-skill setup.
 *
 * Registered responses always win over the synthesised default when
 * synthesis is opted into.
 */
export interface FakeResponse {
  readonly entrypoint: string;
  readonly respond: (
    invocation: SkillInvocation,
  ) => SkillInvocationResult | Promise<SkillInvocationResult>;
}

export interface FakeCodingAgentRunnerOptions {
  /**
   * When `true`, entrypoints with no registered response get a
   * synthesised minimum-valid output from their `outputSchema`. Default
   * is `false` — unregistered entrypoints throw, which is the safer
   * test-time behavior.
   */
  readonly synthesiseDefault?: boolean;
}

const DEFAULT_OPTIONS: Required<FakeCodingAgentRunnerOptions> = {
  synthesiseDefault: false,
};

export class FakeCodingAgentRunner implements CodingAgentRunner {
  readonly codingAgent: string;
  readonly #responses = new Map<string, FakeResponse["respond"]>();
  readonly #synthesiseDefault: boolean;
  readonly invocations: SkillInvocation[] = [];

  constructor(
    codingAgent: string,
    responses: ReadonlyArray<FakeResponse> = [],
    options: FakeCodingAgentRunnerOptions = {},
  ) {
    this.codingAgent = codingAgent;
    for (const r of responses) {
      this.#responses.set(r.entrypoint, r.respond);
    }
    this.#synthesiseDefault =
      options.synthesiseDefault ?? DEFAULT_OPTIONS.synthesiseDefault;
  }

  register(name: string, respond: FakeResponse["respond"]): void {
    this.#responses.set(name, respond);
  }

  /** Usage: synthetic — no provider call, zero tokens, zero cost — with the measured duration. */
  async run(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    const startedAt = performance.now();
    try {
      return await this.#respond(invocation);
    } finally {
      deliverSkillUsage(invocation.onUsage, {
        codingAgent: this.codingAgent,
        ...(invocation.model !== undefined ? { requestedModel: invocation.model } : {}),
        durationMs: Math.round(performance.now() - startedAt),
        synthetic: true,
        measurement: "complete",
        tokens: ZERO_TOKENS,
        models: [],
        quota: { status: "not-applicable", reason: "synthetic run" },
        gaps: [],
      });
    }
  }

  async #respond(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    this.invocations.push(invocation);
    const respond = this.#responses.get(invocation.entrypoint.name);
    if (respond !== undefined) {
      return respond(invocation);
    }
    if (this.#synthesiseDefault) {
      return synthesiseResponse(invocation);
    }
    throw new Error(
      `FakeCodingAgentRunner: no response registered for entrypoint '${invocation.entrypoint.name}' (and synthesiseDefault is off)`,
    );
  }
}

function synthesiseResponse(invocation: SkillInvocation): SkillInvocationResult {
  const value = synthesizeFixture(invocation.entrypoint.outputSchema);
  // Wrap in the canonical fenced-`json` shape the runtime's
  // `extractTerminalJson` expects (one fenced block, trailing content
  // disallowed).
  const responseText = [
    `<thinking>FakeCodingAgentRunner default fixture for /${invocation.entrypoint.name}</thinking>`,
    "",
    "```json",
    JSON.stringify(value),
    "```",
  ].join("\n");
  return { responseText };
}
