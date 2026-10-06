// Copied from leanish/leanish-development core/runtime/src/skill/claude-code-runner.ts at e4f8a1e; see PROVENANCE.md.
import { performance } from "node:perf_hooks";

import { deliverSkillUsage, type SkillUsage, ZERO_TOKENS } from "../usage/skill-usage.ts";
import { buildSlashCommandPrompt } from "./slash-command-prompt.ts";
import { spawnCapture } from "./spawn-capture.ts";
import { stageSkills } from "./stage-skills.ts";
import type {
  CodingAgentRunner,
  SkillInvocation,
  SkillInvocationResult,
} from "./runner.ts";
import { resolveWorkingCopyMount } from "./wc-mount.ts";

/**
 * Coding-agent runner that drives the `claude` (Claude Code) CLI via
 * subprocess. Per ADR-0002, skills are staged into a temp directory and
 * mounted via `--plugin-dir`. The rendered slash-command body is sent as
 * the print-mode prompt.
 *
 * Multi-working-copy mount: the first working copy becomes the spawn `cwd`;
 * every other working copy is passed as `--add-dir <path>` so the
 * subprocess can read and edit across all of them. (Claude Code's
 * `--add-dir` flag is the canonical mechanism for additional working
 * directories.)
 *
 * `effort` plumbing: Claude Code exposes `--effort <low|medium|high|xhigh|max>`.
 * Our internal `Effort` type is `minimal | low | medium | high | xhigh`;
 * we map `minimal → low` (the CLI rejects `minimal`) and pass the rest
 * through verbatim. An operator who wants `max` can set
 * `descriptor.effort = "xhigh"` and rely on `effortLevelMap` if the CLI
 * surface changes; the mapping is documented inline so the contract
 * isn't a hidden table.
 */
export interface ClaudeCodeRunnerOptions {
  /** Override the `claude` binary path. Defaults to `"claude"` (PATH lookup). */
  readonly bin?: string;
  /** Per-invocation timeout in ms. Defaults to 14 minutes (under Lambda's 15-min cap). */
  readonly timeoutMs?: number;
  /** Optional override for staging-temp parent (testing hook). */
  readonly stagingParentDir?: string;
  /** Extra env vars merged onto the subprocess. */
  readonly env?: Readonly<Record<string, string>>;
  /** stdout / stderr capture cap, in bytes. Defaults to 8 MiB. */
  readonly captureCapBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 14 * 60 * 1000;
const DEFAULT_CAPTURE_CAP_BYTES = 8 * 1024 * 1024;

export class ClaudeCodeRunner implements CodingAgentRunner {
  readonly codingAgent = "claude-code";

  readonly #bin: string;
  readonly #timeoutMs: number;
  readonly #stagingParentDir: string | undefined;
  readonly #env: Readonly<Record<string, string>>;
  readonly #captureCapBytes: number;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.#bin = options.bin ?? "claude";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#stagingParentDir = options.stagingParentDir;
    this.#env = options.env ?? {};
    this.#captureCapBytes = options.captureCapBytes ?? DEFAULT_CAPTURE_CAP_BYTES;
  }

  /**
   * Usage: the duration and requested model only. Claude Code's token counts
   * aren't read yet, so a run that reached the CLI reports no tokens, cost or
   * plan usage (a gap); one that failed before it reports zero.
   */
  async run(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    const startedAt = performance.now();
    let spawned = false;
    try {
      return await this.#run(invocation, () => {
        spawned = true;
      });
    } finally {
      deliverSkillUsage(invocation.onUsage, claudeCodeUsage(invocation, Math.round(performance.now() - startedAt), spawned));
    }
  }

  async #run(invocation: SkillInvocation, onSpawn: () => void): Promise<SkillInvocationResult> {
    if (invocation.access === "write") {
      // `--print` grants no tool permissions, so every edit would be denied
      // silently; fail before staging instead.
      throw new Error(
        "ClaudeCodeRunner: access 'write' isn't supported yet (the claude-code runner grants no write permissions) — use codingAgent: codex, or access: read-only",
      );
    }
    const staged = await stageSkills({
      entrypoint: invocation.entrypoint,
      supportSkills: invocation.supportSkills,
      ...(this.#stagingParentDir !== undefined ? { parentDir: this.#stagingParentDir } : {}),
    });
    try {
      const prompt = buildSlashCommandPrompt(invocation);
      const mount = resolveWorkingCopyMount(invocation.workingCopies);
      const args: string[] = ["--print", "--plugin-dir", staged.dir];
      for (const dir of mount.addDirs) {
        args.push("--add-dir", dir);
      }
      if (invocation.model !== undefined) {
        args.push("--model", invocation.model);
      }
      if (invocation.effort !== undefined) {
        args.push("--effort", mapEffortForClaudeCli(invocation.effort));
      }
      args.push(prompt);

      onSpawn();
      return await spawnCapture({
        bin: this.#bin,
        args,
        cwd: mount.cwd,
        // Per-invocation env (target-project credentials) wins over the
        // runner's configured base.
        env: { ...this.#env, ...invocation.env },
        timeoutMs: this.#timeoutMs,
        captureCapBytes: this.#captureCapBytes,
        label: "ClaudeCodeRunner",
        ...(invocation.secrets !== undefined ? { secrets: invocation.secrets } : {}),
      });
    } finally {
      await staged.cleanup();
    }
  }
}

function claudeCodeUsage(invocation: SkillInvocation, durationMs: number, spawned: boolean): SkillUsage {
  const base = {
    codingAgent: "claude-code",
    ...(invocation.model !== undefined ? { requestedModel: invocation.model } : {}),
    durationMs,
    synthetic: false,
    models: [],
  };
  if (!spawned) {
    return {
      ...base,
      measurement: "complete",
      tokens: ZERO_TOKENS,
      quota: { status: "not-applicable", reason: "no provider call was made" },
      gaps: [],
    };
  }
  return {
    ...base,
    measurement: "partial",
    quota: { status: "unavailable" },
    gaps: ["the claude-code runner doesn't read Claude Code's token usage, so there are no tokens, cost or plan usage"],
  };
}

/**
 * Map the suite's `Effort` vocabulary onto Claude Code's CLI surface.
 *
 *   - Claude CLI: `--effort <low|medium|high|xhigh|max>` (validated by `claude --help`).
 *   - Suite: `minimal | low | medium | high | xhigh`.
 *
 * `minimal` collapses to `low` because the CLI rejects `minimal`; every
 * other value passes through verbatim. The suite has no `max` — operators
 * who want `max` would need to widen the suite-level `Effort` type first.
 *
 * Exported so tests can assert the mapping and downstream tooling can
 * compose against the same table without re-deriving it.
 */
export function mapEffortForClaudeCli(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}
