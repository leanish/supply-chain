// Copied from leanish/leanish-development core/runtime/src/skill/stage-skills.ts at c6282df; see PROVENANCE.md.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LoadedSkill } from "./skill.ts";

/**
 * Stages an entrypoint + support skills into a temp directory using the
 * canonical Claude Code `--plugin-dir` layout (ADR-0001 + ADR-0002):
 *
 *   <staged>/
 *   ├── .claude-plugin/plugin.json
 *   └── skills/
 *       ├── <entrypoint>/SKILL.md
 *       └── <support>/SKILL.md   (one per support skill)
 *
 * The layout itself is written by `writePluginDir` (shared with the seat-mode
 * installer, so "valid plugin layout" has exactly one definition). This
 * function adds the per-invocation concerns: a fresh temp dir and a
 * `cleanup()` the caller must run when the subprocess finishes.
 *
 * If the same skill name appears in both the entrypoint and support lists,
 * the entrypoint version wins (`writePluginDir` de-duplicates, first wins).
 */
export interface StagedSkills {
  readonly dir: string;
  cleanup(): Promise<void>;
}

export interface StageSkillsArgs {
  readonly entrypoint: LoadedSkill;
  readonly supportSkills: ReadonlyArray<LoadedSkill>;
  /** Optional override for the temp directory parent (defaults to `os.tmpdir()`). */
  readonly parentDir?: string;
  /** Optional plugin name written into the manifest. */
  readonly pluginName?: string;
}

export async function stageSkills(args: StageSkillsArgs): Promise<StagedSkills> {
  const parent = args.parentDir ?? tmpdir();
  const dir = await mkdtemp(join(parent, "agent-runtime-skill-"));
  try {
    await writePluginDir({
      dir,
      pluginName: args.pluginName ?? "agent-runtime-staged",
      description: "Skills staged by @leanish/runtime for one runSkill invocation.",
      skills: [args.entrypoint, ...args.supportSkills],
    });
    return {
      dir,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export interface WritePluginDirArgs {
  /** Target directory (created if missing); the canonical layout is written under it. */
  readonly dir: string;
  /** Manifest `name` — the plugin namespace Claude Code uses (`/<name>:<skill>`). */
  readonly pluginName: string;
  /** Manifest `description`. */
  readonly description: string;
  /** Skills to include; duplicates by name are de-duplicated, first occurrence wins. */
  readonly skills: ReadonlyArray<LoadedSkill>;
}

/**
 * Write the canonical Claude Code `--plugin-dir` layout into `dir`:
 *
 *   <dir>/.claude-plugin/plugin.json
 *   <dir>/skills/<name>/SKILL.md   (one per skill — byte-identical copy)
 *
 * Each skill directory is copied **byte-identical** via `fs.cp` (recursive),
 * preserving companion files the author shipped (scripts/, references/, …)
 * without round-tripping frontmatter through a YAML emitter.
 *
 * This is the single definition of "valid plugin layout", shared by the
 * runtime's per-invocation staging (`stageSkills`) and the seat-mode
 * installer (`install-skills`).
 */
export async function writePluginDir(args: WritePluginDirArgs): Promise<void> {
  await mkdir(args.dir, { recursive: true });
  // Idempotent reinstall: clear the canonical subdirs we own so re-running
  // into an existing dir (e.g. after a skill was removed/renamed) can't leave
  // stale skills visible. Unrelated files under `dir` are left untouched. (For
  // `stageSkills`, `dir` is a fresh temp dir, so these are no-ops.)
  await rm(join(args.dir, ".claude-plugin"), { recursive: true, force: true });
  await rm(join(args.dir, "skills"), { recursive: true, force: true });
  const manifestDir = join(args.dir, ".claude-plugin");
  await mkdir(manifestDir, { recursive: true });
  const manifest = {
    name: args.pluginName,
    version: "0.0.0",
    description: args.description,
    // `author` is required for `claude plugin validate --strict` to pass (it
    // promotes the "no author" warning to an error) — the seat installer prints
    // that strict check as its smoke test. Suite-wide constant; no caller varies it.
    author: { name: "leanish" },
  };
  await writeFile(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  await mkdir(join(args.dir, "skills"), { recursive: true });
  const seen = new Set<string>();
  for (const skill of args.skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    // `LoadedSkill.path` points at the source `SKILL.md`; copy its parent dir.
    await cp(dirname(skill.path), join(args.dir, "skills", skill.name), { recursive: true });
  }
}
