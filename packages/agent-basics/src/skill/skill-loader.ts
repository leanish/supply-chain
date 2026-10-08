// Copied from leanish/leanish-development core/runtime/src/skill/skill-loader.ts at e4f8a1e; see PROVENANCE.md.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { EntrypointSchemaError } from "../errors.ts";

import { assertSubset } from "./schema-subset.ts";
import type { LoadedSkill } from "./skill.ts";

/**
 * Loads `SKILL.md` files from a precedence-ordered list of skill
 * directories.
 *
 * Filesystem layout per directory (canonical per ADR-0001):
 *
 *   <skillsDir>/<skillName>/SKILL.md
 *
 * Each `SKILL.md` starts with YAML frontmatter (between two `---` lines)
 * containing the skill's `description`, `inputSchema`, `outputSchema`, and
 * optional `compatibleCodingAgents`. The body that follows is the prompt
 * the coding agent sees.
 *
 * **Multi-directory search** — the loader walks `skillsDirs` in order
 * and returns the first match. Agents pass `[<agent-pkg>/skills,
 * <runtime-pkg>/skills]` so agent-specific entry-point skills (e.g.
 * ATC's `ask`) live with the agent, while truly shared support skills
 * (e.g. `karpathy-guidelines`) live in the runtime and are inherited.
 * An agent can override a runtime-bundled skill by shadowing it in its
 * own skills directory (same name, agent wins).
 *
 * When a skill name resolves to a file in one of the configured
 * directories, the cache keys the result by skill name (not by path) —
 * subsequent loads return the same `LoadedSkill` without re-resolving
 * the precedence chain.
 */
export interface SkillLoaderOptions {
  /**
   * Precedence-ordered list of directories to search for `<name>/SKILL.md`.
   * Earlier entries win. Must contain at least one entry.
   */
  readonly skillsDirs: ReadonlyArray<string>;
}

export class SkillLoader {
  readonly #skillsDirs: ReadonlyArray<string>;
  readonly #cache = new Map<string, LoadedSkill>();

  constructor(options: SkillLoaderOptions) {
    if (options.skillsDirs.length === 0) {
      throw new Error("SkillLoader: skillsDirs must contain at least one entry");
    }
    this.#skillsDirs = options.skillsDirs;
  }

  async load(name: string): Promise<LoadedSkill> {
    const cached = this.#cache.get(name);
    if (cached !== undefined) return cached;
    const attempted: string[] = [];
    for (const dir of this.#skillsDirs) {
      const path = join(dir, name, "SKILL.md");
      attempted.push(path);
      try {
        const raw = await readFile(path, "utf8");
        const skill = parseSkillFile(raw, name, path);
        this.#cache.set(name, skill);
        return skill;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
    }
    throw new Error(
      `SkillLoader: skill '${name}' not found. Searched:\n  - ${attempted.join("\n  - ")}`,
    );
  }

  async loadEntrypoint(name: string): Promise<LoadedSkill> {
    const skill = await this.load(name);
    if (skill.inputSchema === undefined) {
      throw new EntrypointSchemaError(name, "missing 'inputSchema' in frontmatter");
    }
    if (skill.outputSchema === undefined) {
      throw new EntrypointSchemaError(name, "missing 'outputSchema' in frontmatter");
    }
    assertSubset(skill.inputSchema, name);
    assertSubset(skill.outputSchema, name);
    return skill;
  }
}

/** Visible for tests. */
export function parseSkillFile(raw: string, name: string, path: string): LoadedSkill {
  const fm = extractFrontmatter(raw);
  if (fm === undefined) {
    return { name, body: raw.trim(), path };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(fm.frontmatter);
  } catch (err) {
    throw new EntrypointSchemaError(
      name,
      `frontmatter YAML failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EntrypointSchemaError(name, "frontmatter must be a YAML mapping");
  }
  const value = parsed as Record<string, unknown>;
  const description = typeof value["description"] === "string" ? value["description"] : undefined;
  const compatibleCodingAgents = parseCompatibleCodingAgents(value["compatibleCodingAgents"], name);
  const inputSchema = parseSchemaField(value["inputSchema"], "inputSchema", name);
  const outputSchema = parseSchemaField(value["outputSchema"], "outputSchema", name);
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(compatibleCodingAgents !== undefined ? { compatibleCodingAgents } : {}),
    body: fm.body.trim(),
    path,
  };
}

interface FrontmatterSplit {
  readonly frontmatter: string;
  readonly body: string;
}

function extractFrontmatter(raw: string): FrontmatterSplit | undefined {
  // Tolerate leading whitespace; the opening delimiter must be `---` on its own line.
  const opener = /^---\r?\n/;
  const openerMatch = opener.exec(raw);
  if (openerMatch === null || openerMatch.index !== 0) return undefined;
  const rest = raw.slice(openerMatch[0].length);
  const closerMatch = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (closerMatch === null) return undefined;
  return {
    frontmatter: rest.slice(0, closerMatch.index),
    body: rest.slice(closerMatch.index + closerMatch[0].length),
  };
}

function parseSchemaField(value: unknown, field: string, name: string): object | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EntrypointSchemaError(name, `'${field}' must be a mapping in the frontmatter`);
  }
  return value as object;
}

function parseCompatibleCodingAgents(
  value: unknown,
  name: string,
): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new EntrypointSchemaError(
      name,
      `'compatibleCodingAgents' must be an array of strings`,
    );
  }
  return value as ReadonlyArray<string>;
}
