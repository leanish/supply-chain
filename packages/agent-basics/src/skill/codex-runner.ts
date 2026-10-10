// Copied from leanish/leanish-development core/runtime/src/skill/codex-runner.ts at c6282df; see PROVENANCE.md.
// Local changes: the access comment says write agents can't write git metadata (they never could here).
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { NOOP_REDACTOR, Redactor } from "../logger/redactor.ts";
import type { WorkingCopy } from "../types/working-copy.ts";
import { deliverSkillUsage } from "../usage/skill-usage.ts";
import {
  assertCodexLoginAvailable,
  CodexLoginKeptError,
  linkCodexLogin,
  reconcileCodexLogin,
} from "./codex-login.ts";
import { commandEnvArgs, githubToolsEnv } from "./codex-command-env.ts";
import { assertEffortSupported, isCodexModelFamily, parseCodexCatalog, resolveCodexModel } from "./codex-model.ts";
import { assertAbsolute, assertOutsideDenied, codexPermissionArgs, validateReadRules } from "./codex-permissions.ts";
import { readQuotaBaseline } from "./codex-quota-baseline.ts";
import { CodexUsageMeter } from "./codex-usage-meter.ts";
import { buildSlashCommandPrompt } from "./slash-command-prompt.ts";
import { scrubbedProcessEnv, spawnCapture, withoutAmbientCredentials } from "./spawn-capture.ts";
import { stageSkills, type StagedSkills } from "./stage-skills.ts";
import type {
  CodingAgentRunner,
  SkillInvocation,
  SkillInvocationResult,
} from "./runner.ts";
import { resolveWorkingCopyMount } from "./wc-mount.ts";

/**
 * Coding-agent runner that drives the `codex` (OpenAI Codex CLI) via
 * subprocess. Per ADR-0002, skills are staged into a temp directory and
 * mounted by setting `CODEX_HOME=<staged>` so Codex auto-discovers
 * `<CODEX_HOME>/skills/<name>/SKILL.md`.
 *
 * Subprocess shape:
 *
 *   CODEX_HOME=<staged> codex exec --ignore-user-config -c project_doc_max_bytes=0 \
 *     -c default_permissions="agent-runtime" -c permissions.agent-runtime.… \
 *     -c approval_policy="never" \
 *     [--add-dir <wc-path>] ... [-c model_reasoning_effort=<effort>] \
 *     [--model <model>] "/<entrypoint> <rendered args>"
 *
 * Access (`invocation.access`, from the descriptor) picks the permission
 * profile (see `codex-permissions.ts`): `read-only` can read, not write, and
 * has no network; `write` can also write its working copies' files (their git
 * metadata stays read-only, so it can't commit or push), the temp dirs and
 * `writableRoots`, and reach the network — it needs at least one working copy,
 * each with its git metadata in a separate directory outside the working tree.
 * `readDenied` / `readAllowed` keep sandboxed commands away from paths (a
 * local run denies the developer's home — working copies and writable roots
 * must then live outside it); the staged `CODEX_HOME`'s `auth.json` is always
 * unreadable to them. On Linux the profile needs
 * bubblewrap, i.e. unprivileged user namespaces; where they're unavailable
 * (e.g. Lambda) Codex refuses sandboxed commands rather than running them
 * unconfined.
 *
 * Flags chosen per ADR-0002 §Mount mechanism per backend:
 *   - `--ignore-user-config` suppresses `~/.codex` so the developer's
 *     personal config doesn't leak into the run.
 *   - `-c project_doc_max_bytes=0` suppresses ambient project-level
 *     AGENTS.md / similar from being injected.
 *   - `-c allow_login_shell=false -c features.shell_snapshot=false` keep the
 *     user's shell startup files from rewriting the commands' env.
 *   - `-c shell_environment_policy.*` (always, after the permission flags):
 *     the commands get exactly the CLI's env minus Codex's own API keys
 *     (`codex-command-env.ts`); with a `GH_TOKEN`, git reaches it through
 *     `GIT_ASKPASS`.
 *
 * Multi-working-copy mount: the first working copy is the spawn `cwd`;
 * every other working copy is passed as `--add-dir <path>` so the
 * subprocess can read/edit across all of them. (Codex CLI's `--add-dir`
 * is the canonical mechanism.)
 *
 * `effort` mapping: when `RunSkillArgs.effort` resolves to a non-undefined
 * value the runner sets `-c model_reasoning_effort=<value>`. Codex uses
 * `model_reasoning_effort` as the config key; values typically map to
 * `minimal | low | medium | high` but unknown values are propagated
 * verbatim so the CLI's own validation owns the surface.
 *
 * Usage (`SkillInvocation.onUsage`, see `codex-usage-meter.ts`): right before
 * `exec`, a quota reading through `codex app-server` with the same env (its
 * own short timeout, within the invocation's); after it, before the staged
 * home is removed, the tokens and rate limits Codex recorded in its session
 * files there (`codex-rollouts.ts`).
 */
export interface CodexRunnerOptions {
  /** Override the `codex` binary path. Defaults to `"codex"` (PATH lookup). */
  readonly bin?: string;
  /**
   * Per-invocation timeout in ms, shared by model-family discovery and the run
   * itself. Defaults to 14 minutes (under Lambda's 15-min cap).
   */
  readonly timeoutMs?: number;
  /** Optional override for staging-temp parent (testing hook). */
  readonly stagingParentDir?: string;
  /** Extra env vars merged onto the subprocess (in addition to `CODEX_HOME`). */
  readonly env?: Readonly<Record<string, string>>;
  /** stdout / stderr capture cap, in bytes. Defaults to 8 MiB. */
  readonly captureCapBytes?: number;
  /**
   * Optional override of the suppression flags. Defaults to the ADR-0002
   * pair (`--ignore-user-config`, `-c project_doc_max_bytes=0`). Tests
   * pass `[]` so a stub binary doesn't have to know about Codex flags.
   */
  readonly suppressFlags?: ReadonlyArray<string>;
  /**
   * Codex TOML config key used to thread the resolved `effort` value
   * through as `-c <key>=<value>`. Defaults to `"model_reasoning_effort"`
   * — the documented key in Codex's TOML config schema as of this
   * implementation. The Codex CLI surface around reasoning effort has
   * moved (`reasoning_effort` is also seen in some upstream branches);
   * override here if a CLI smoke-test against the installed version
   * shows the key needs to be different. Phase-1 ships the documented
   * default; a follow-up will pin the key against the live CLI.
   */
  readonly effortConfigKey?: string;
  /**
   * Extra directories a `write` invocation may write to, besides its working
   * copies (e.g. a dedicated build-tool cache). Ignored for `read-only`.
   */
  readonly writableRoots?: ReadonlyArray<string>;
  /**
   * Build-tool cache for the run: `GRADLE_USER_HOME` and `npm_config_cache`
   * point inside it (set after the invocation env, so target credentials
   * can't redirect them), and a `write` run may write to it (created if
   * absent). Absolute.
   */
  readonly buildCacheRoot?: string;
  /** Absolute paths sandboxed commands may not read (e.g. the developer's home). */
  readonly readDenied?: ReadonlyArray<string>;
  /** Absolute paths inside `readDenied` that stay readable (e.g. toolchains). */
  readonly readAllowed?: ReadonlyArray<string>;
  /**
   * Codex home whose file-backed login (`auth.json`) the staged home links to,
   * so a local run uses the developer's `codex login` instead of an API key.
   * Unset (the default, and AWS mode): no login is linked. See `codex-login.ts`.
   */
  readonly loginHome?: string;
  /**
   * Cap on the quota reading taken through `codex app-server` right before
   * the run (see `codex-quota-baseline.ts`), itself within the invocation
   * timeout. Defaults to 15 seconds.
   */
  readonly quotaBaselineTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 14 * 60 * 1000;
const DEFAULT_CAPTURE_CAP_BYTES = 8 * 1024 * 1024;
const DEFAULT_SUPPRESS_FLAGS: ReadonlyArray<string> = [
  "--ignore-user-config",
  "-c",
  "project_doc_max_bytes=0",
  // Commands get the env the runner passes, not one rebuilt from the user's
  // shell startup files (a login shell, or the snapshot Codex takes of one);
  // see also `shellIsolationEnv`.
  "-c",
  "allow_login_shell=false",
  "-c",
  "features.shell_snapshot=false",
];
const DEFAULT_EFFORT_CONFIG_KEY = "model_reasoning_effort";
const CATALOG_TIMEOUT_MS = 60 * 1000;
const DEFAULT_QUOTA_BASELINE_TIMEOUT_MS = 15 * 1000;

export class CodexRunner implements CodingAgentRunner {
  readonly codingAgent = "codex";

  readonly #bin: string;
  readonly #timeoutMs: number;
  readonly #stagingParentDir: string | undefined;
  readonly #env: Readonly<Record<string, string>>;
  readonly #captureCapBytes: number;
  readonly #suppressFlags: ReadonlyArray<string>;
  readonly #effortConfigKey: string;
  readonly #writableRoots: ReadonlyArray<string>;
  readonly #cacheEnv: Readonly<Record<string, string>>;
  readonly #readDenied: ReadonlyArray<string>;
  readonly #readAllowed: ReadonlyArray<string>;
  readonly #loginHome: string | undefined;
  readonly #quotaBaselineTimeoutMs: number;

  constructor(options: CodexRunnerOptions = {}) {
    this.#bin = options.bin ?? "codex";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#stagingParentDir = options.stagingParentDir;
    this.#env = options.env ?? {};
    this.#captureCapBytes = options.captureCapBytes ?? DEFAULT_CAPTURE_CAP_BYTES;
    this.#suppressFlags = options.suppressFlags ?? DEFAULT_SUPPRESS_FLAGS;
    this.#effortConfigKey = options.effortConfigKey ?? DEFAULT_EFFORT_CONFIG_KEY;
    const cacheRoot = options.buildCacheRoot;
    this.#writableRoots = [...(options.writableRoots ?? []), ...(cacheRoot !== undefined ? [cacheRoot] : [])];
    assertAbsolute(this.#writableRoots, "writableRoots/buildCacheRoot");
    this.#cacheEnv =
      cacheRoot === undefined
        ? {}
        : { GRADLE_USER_HOME: join(cacheRoot, "gradle"), npm_config_cache: join(cacheRoot, "npm") };
    this.#readDenied = options.readDenied ?? [];
    this.#readAllowed = options.readAllowed ?? [];
    validateReadRules(this.#readDenied, this.#readAllowed);
    assertOutsideDenied(this.#writableRoots, this.#readDenied, "writable root");
    // Absolute, so the symlink in the staged home doesn't resolve relative to it.
    this.#loginHome = options.loginHome === undefined ? undefined : resolve(options.loginHome);
    this.#quotaBaselineTimeoutMs = options.quotaBaselineTimeoutMs ?? DEFAULT_QUOTA_BASELINE_TIMEOUT_MS;
  }

  async run(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    const meter = new CodexUsageMeter(invocation.model);
    try {
      return await this.#run(invocation, meter);
    } finally {
      deliverSkillUsage(invocation.onUsage, meter.snapshot());
    }
  }

  async #run(invocation: SkillInvocation, meter: CodexUsageMeter): Promise<SkillInvocationResult> {
    const deadline = Date.now() + this.#timeoutMs;
    const access = invocation.access ?? "read-only";
    assertOutsideDenied(
      invocation.workingCopies.map((wc) => wc.path),
      this.#readDenied,
      "working copy",
    );
    const gitDirs = access === "write" ? await writeMountGitDirs(invocation.workingCopies) : [];
    // Codex's own API key is the one ambient credential the CLI keeps; nothing else credential-shaped
    // reaches it unless the runner's env or the invocation's target credentials pass it on purpose.
    const codexApiKey = nonEmpty({ ...scrubbedProcessEnv(), ...this.#env, ...invocation.env }["CODEX_API_KEY"]);
    if (this.#loginHome !== undefined) {
      await assertCodexLoginAvailable(this.#loginHome, codexApiKey !== undefined ? { CODEX_API_KEY: codexApiKey } : {});
    }
    const staged = await stageSkills({
      entrypoint: invocation.entrypoint,
      supportSkills: invocation.supportSkills,
      ...(this.#stagingParentDir !== undefined ? { parentDir: this.#stagingParentDir } : {}),
    });
    let runError: unknown;
    try {
      if (access === "write") {
        for (const root of this.#writableRoots) await mkdir(root, { recursive: true, mode: 0o700 });
      }
      if (this.#loginHome !== undefined) await linkCodexLogin(staged.dir, this.#loginHome);
      const prompt = buildSlashCommandPrompt(invocation);
      const mount = resolveWorkingCopyMount(invocation.workingCopies);
      // Codex discovers staged skills via CODEX_HOME, so it rides on top of
      // the runner's configured env (+ per-invocation target credentials);
      // the cache routing, shell isolation and CODEX_HOME go last — nothing may
      // shadow them.
      const env = {
        ...(codexApiKey !== undefined ? { CODEX_API_KEY: codexApiKey } : {}),
        ...this.#env,
        ...invocation.env,
        ...this.#cacheEnv,
        ...(await shellIsolationEnv(staged.dir)),
        ...(nonEmpty({ ...this.#env, ...invocation.env }["GH_TOKEN"]) !== undefined
          ? await githubToolsEnv(staged.dir)
          : {}),
        CODEX_HOME: staged.dir,
      };
      const model =
        invocation.model === undefined
          ? undefined
          : await this.#resolveModel(invocation.model, invocation.effort, mount.cwd, env, invocation, deadline);
      meter.modelResolved(model);
      const args: string[] = [
        "exec",
        ...this.#suppressFlags,
        ...codexPermissionArgs({
          access,
          gitDirs,
          stagedHome: staged.dir,
          writableRoots: access === "write" ? this.#writableRoots : [],
          readDenied: this.#readDenied,
          readAllowed: this.#readAllowed,
        }),
        // The same env spawnCapture builds for the CLI below.
        ...commandEnvArgs({ ...withoutAmbientCredentials(scrubbedProcessEnv()), ...env }),
      ];
      for (const dir of mount.addDirs) {
        args.push("--add-dir", dir);
      }
      if (invocation.effort !== undefined) {
        args.push("-c", `${this.#effortConfigKey}=${invocation.effort}`);
      }
      if (model !== undefined) {
        args.push("--model", model);
      }
      args.push(prompt);

      await this.#readQuotaBaseline(meter, mount.cwd, env, invocation, deadline);
      const timeoutMs = this.#remainingMs(deadline);
      meter.execStarted();
      const result = await spawnCapture({
        bin: this.#bin,
        args,
        cwd: mount.cwd,
        env,
        timeoutMs,
        captureCapBytes: this.#captureCapBytes,
        label: "CodexRunner",
        scrubAmbientCredentials: true,
        ...(invocation.secrets !== undefined ? { secrets: invocation.secrets } : {}),
      });
      meter.execSucceeded();
      return model !== undefined && model !== invocation.model ? { ...result, model } : result;
    } catch (err) {
      runError = err;
      throw err;
    } finally {
      // Codex's session files hold the run's usage; read them before the home goes.
      await meter.collectRollouts(staged.dir);
      await this.#finish(staged, runError);
    }
  }

  /**
   * The quota reading the run's usage is compared with, taken right before
   * `exec` with the same env and login, within what's left of the budget.
   * A failed reading is a gap in the usage, never a failed run.
   */
  async #readQuotaBaseline(
    meter: CodexUsageMeter,
    cwd: string,
    env: Readonly<Record<string, string>>,
    invocation: SkillInvocation,
    deadline: number,
  ): Promise<void> {
    try {
      meter.baselineRead(
        await readQuotaBaseline({
          bin: this.#bin,
          cwd,
          env,
          timeoutMs: Math.min(this.#quotaBaselineTimeoutMs, this.#remainingMs(deadline)),
          redactor:
            invocation.secrets !== undefined && invocation.secrets.length > 0 ? new Redactor(invocation.secrets) : NOOP_REDACTOR,
        }),
      );
    } catch (err) {
      meter.baselineFailed(err);
    }
  }

  /**
   * Runs after the CLI has exited (also on failure or timeout): checks the
   * linked login, then removes the staged home — unless it still holds
   * credentials that couldn't be saved elsewhere.
   */
  async #finish(staged: StagedSkills, runError: unknown): Promise<void> {
    try {
      if (this.#loginHome !== undefined) await reconcileCodexLogin(staged.dir, this.#loginHome, runError);
    } catch (err) {
      if (!(err instanceof CodexLoginKeptError)) await staged.cleanup();
      throw err;
    }
    await staged.cleanup();
  }

  /**
   * A family name (`luna`, `sol`, `astra`) becomes the newest listed model of
   * that family in the catalog Codex reports, with the requested effort checked
   * against it. A concrete model id is passed through untouched.
   */
  async #resolveModel(
    model: string,
    effort: string | undefined,
    cwd: string,
    env: Readonly<Record<string, string>>,
    invocation: SkillInvocation,
    deadline: number,
  ): Promise<string> {
    if (!isCodexModelFamily(model)) return model;
    const { responseText } = await spawnCapture({
      bin: this.#bin,
      args: ["debug", "models"],
      cwd,
      env,
      timeoutMs: Math.min(CATALOG_TIMEOUT_MS, this.#remainingMs(deadline)),
      captureCapBytes: this.#captureCapBytes,
      label: "CodexRunner (debug models)",
      scrubAmbientCredentials: true,
      ...(invocation.secrets !== undefined ? { secrets: invocation.secrets } : {}),
    });
    const resolved = resolveCodexModel(model, parseCodexCatalog(responseText));
    assertEffortSupported(resolved, effort);
    return resolved.slug;
  }

  /** Time left of the invocation budget; fails instead of spawning with none left. */
  #remainingMs(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`CodexRunner: the ${this.#timeoutMs}ms invocation budget ran out before '${this.#bin}' could run`);
    }
    return remaining;
  }
}

/**
 * A `write` run needs at least one working copy, each with its git metadata
 * kept outside the working tree (`LocalGitWorkspace`); returns those git dirs,
 * which the agent sees read-only. The agent edits files; the runtime commits
 * and pushes (`Runtime.publishBranch`).
 */
async function writeMountGitDirs(workingCopies: ReadonlyArray<WorkingCopy>): Promise<string[]> {
  if (workingCopies.length === 0) {
    throw new Error(
      "CodexRunner: access 'write' needs at least one working copy — without one Codex would write in the process's own directory",
    );
  }
  return Promise.all(workingCopies.map((wc) => separateGitDir(wc)));
}

async function separateGitDir(workingCopy: WorkingCopy): Promise<string> {
  const gitDir = workingCopy.gitDir;
  const entry = gitDir === undefined ? undefined : await lstat(gitDir).catch(() => undefined);
  if (gitDir === undefined || entry === undefined || !entry.isDirectory()) {
    throw new Error(`CodexRunner: access 'write' needs ${workingCopy.path}'s git metadata in a separate directory`);
  }
  const fromWorkingCopy = relative(resolve(workingCopy.path), resolve(gitDir));
  if (fromWorkingCopy === "" || (!fromWorkingCopy.startsWith("..") && !isAbsolute(fromWorkingCopy))) {
    throw new Error(`CodexRunner: ${workingCopy.path}'s git metadata must live outside the working tree`);
  }
  return gitDir;
}

/**
 * Codex runs commands with the user's shell, and zsh reads `$ZDOTDIR/.zshenv`
 * (default `$HOME`) on every invocation, login or not — so the user's startup
 * files could still rewrite the env the runner passes. Point zsh at an empty
 * directory and clear bash's `BASH_ENV`.
 */
async function shellIsolationEnv(stagedHome: string): Promise<Record<string, string>> {
  const zdotdir = join(stagedHome, "zdotdir");
  await mkdir(zdotdir, { recursive: true });
  return { ZDOTDIR: zdotdir, BASH_ENV: "" };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
