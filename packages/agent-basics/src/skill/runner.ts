// Copied from leanish/leanish-development core/runtime/src/skill/runner.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: `Access` from `types/access.ts` instead of the agent descriptor.
import type { SecretEntry } from "../logger/redactor.ts";
import type { Access } from "../types/access.ts";
import type { WorkingCopy } from "../types/working-copy.ts";
import type { SkillUsage } from "../usage/skill-usage.ts";
import type { LoadedSkill } from "./skill.ts";

/**
 * Subprocess-level abstraction for invoking a coding agent. The runtime
 * picks an implementation based on `descriptor.codingAgent` (`claude-code`
 * or `codex` in phase 1).
 *
 * One implementation per coding agent CLI; phase-2+ direct-API runners
 * land as additional implementations behind the same interface.
 */
export interface CodingAgentRunner {
  readonly codingAgent: string;
  run(invocation: SkillInvocation): Promise<SkillInvocationResult>;
}

export interface SkillInvocation {
  readonly entrypoint: LoadedSkill;
  readonly supportSkills: ReadonlyArray<LoadedSkill>;
  readonly renderedArguments: string;
  readonly workingCopies: ReadonlyArray<WorkingCopy>;
  readonly model?: string;
  readonly effort?: string;
  /**
   * What the coding agent may change; absent means `read-only`. `runSkill`
   * sets it from the descriptor only (never from `RunSkillArgs` or a message
   * payload). A runner that can't grant it must fail before spawning.
   */
  readonly access?: Access;
  /**
   * Per-invocation env vars merged onto the subprocess (after the runner's
   * own configured env base). Populated by `runSkill` from the
   * `TargetCredentialsResolver` when the agent declares the
   * `target-credentials` need; absent otherwise.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Secret values among `env`, redacted from captured stdout/stderr (and
   * error tails) before anything leaves the subprocess boundary.
   */
  readonly secrets?: ReadonlyArray<SecretEntry>;
  /**
   * Receives what the attempt consumed (`SkillUsage`): exactly one frozen
   * snapshot per `run`, on success and on every failure — failures before
   * anything was staged included — after the runner's own cleanup. A runner
   * delivers it with `deliverSkillUsage`, so a throwing callback can't
   * replace the run's outcome. `runSkill` sets it; a runner that never calls
   * it shows up in the usage record as an explicit gap.
   */
  readonly onUsage?: (usage: SkillUsage) => void;
}

export interface SkillInvocationResult {
  /**
   * Full text the coding agent emitted on its terminal channel. The runtime
   * parses the final fenced-`json` block out of this.
   */
  readonly responseText: string;
  /** Tail of stderr when the subprocess emitted anything there. */
  readonly stderrTail?: string;
  /** Concrete model the coding agent ran, when the runner resolved it from a family name. */
  readonly model?: string;
}
