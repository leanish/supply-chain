// Copied from leanish/leanish-development core/runtime/src/skill/skill.ts at c6282df; see PROVENANCE.md.
/**
 * A loaded Entry-point Skill — frontmatter parsed, body separated. Support
 * skills go through the same loader but their `inputSchema`/`outputSchema`
 * are ignored at runtime (per ADR-0004).
 */
export interface LoadedSkill {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: object;
  readonly outputSchema?: object;
  readonly compatibleCodingAgents?: ReadonlyArray<string>;
  /** The body text following the frontmatter — sent to the coding agent. */
  readonly body: string;
  /** Absolute path to the loaded SKILL.md (for staging). */
  readonly path: string;
}
