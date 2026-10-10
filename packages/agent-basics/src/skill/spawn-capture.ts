// Copied from leanish/leanish-development core/runtime/src/skill/spawn-capture.ts at c6282df; see PROVENANCE.md.
import { spawn } from "node:child_process";

import { NOOP_REDACTOR, Redactor, type SecretEntry } from "../logger/redactor.ts";
import type { SkillInvocationResult } from "./runner.ts";
import { tail } from "./tail.ts";

export interface SpawnCaptureOptions {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Extra env merged on top of the scrubbed `process.env` (e.g. `CODEX_HOME`). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly captureCapBytes: number;
  /** Prefix for timeout / non-zero-exit error messages, e.g. `"ClaudeCodeRunner"`. */
  readonly label: string;
  /**
   * Secret values substring-replaced with `<redacted:NAME>` in the captured
   * stdout / stderr (including error tails) before anything is returned or
   * thrown. Exact-string matching via `Redactor` — no heuristics.
   */
  readonly secrets?: ReadonlyArray<SecretEntry>;
  /**
   * Also drop every credential-shaped variable (see `withoutAmbientCredentials`) from the
   * inherited base, so the CLI holds only the credentials passed in `env` deliberately.
   */
  readonly scrubAmbientCredentials?: boolean;
}

/**
 * AWS credential / credential-source env vars stripped from the
 * `process.env` base before the coding-agent subprocess is spawned. The
 * execution role's permissions (e.g. `ssm:GetParameter` over every
 * project's credentials once `target-credentials` is granted) must not be
 * ambiently available to the model subprocess — it gets exactly the env
 * the runtime resolved for it, nothing more.
 *
 * The scrub applies to the inherited base only: an operator who genuinely
 * needs to hand AWS credentials to the subprocess (e.g. a Bedrock-auth
 * CLI) re-adds them deliberately via the runner's `options.env`, which
 * merges after the scrub. Catalog data can never re-add them — the
 * credentials schema bans the `AWS_` prefix outright.
 */
export const SCRUBBED_AWS_ENV_VARS: ReadonlyArray<string> = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
];

/** `process.env` minus the AWS credential vars (see `SCRUBBED_AWS_ENV_VARS`). */
export function scrubbedProcessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of SCRUBBED_AWS_ENV_VARS) {
    delete env[name];
  }
  return env;
}

/**
 * Names that look like credentials: tokens, secrets, passwords, API and private keys,
 * credential files, auth settings, and the SSH agent socket (a way to sign as the user).
 */
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSW|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|_AUTH(_|$)/i;

/** `env` minus every credential-shaped variable (`CREDENTIAL_NAME`). */
export function withoutAmbientCredentials(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_NAME.test(name)));
}

/**
 * Spawn a coding-agent CLI and capture its terminal output. Shared by
 * `ClaudeCodeRunner` and `CodexRunner` — the only per-runner differences are
 * the assembled `args`, the extra `env` (Codex injects `CODEX_HOME`), and the
 * `label` used in error messages.
 *
 * Behaviour:
 *   - stdout / stderr captured up to `captureCapBytes` (bytes beyond the cap
 *     are counted but dropped, so a runaway subprocess can't exhaust memory);
 *   - the CLI runs in its own process group: on a timeout, and after it
 *     exits, the whole group is SIGKILLed and awaited — every command it
 *     started, orphaned ones included, is gone before this settles, so a
 *     caller cleaning up never races a write. Ctrl-C/SIGTERM/SIGHUP reaching
 *     this process while it runs are passed on to the group;
 *   - non-zero exit rejects with the exit code + a stderr tail;
 *   - success resolves to `{ responseText, stderrTail? }`.
 *
 * The git-backed `LocalGitWorkspace` deliberately does *not* use this: it
 * treats the exit code as data and has no timeout / capture cap.
 */
export function spawnCapture(options: SpawnCaptureOptions): Promise<SkillInvocationResult> {
  const redactor =
    options.secrets !== undefined && options.secrets.length > 0
      ? new Redactor(options.secrets)
      : NOOP_REDACTOR;
  return new Promise((resolve, reject) => {
    const child = spawn(options.bin, [...options.args], {
      cwd: options.cwd,
      env: {
        ...(options.scrubAmbientCredentials === true ? withoutAmbientCredentials(scrubbedProcessEnv()) : scrubbedProcessEnv()),
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group (id = its pid), so ending the run ends everything it started.
      detached: true,
    });
    const group = child.pid;
    const stopForwarding = forwardTerminationSignals(group);

    let stdout = "";
    let stderr = "";
    const cap = options.captureCapBytes;

    // Keep the most-recent `cap` chars of each stream (a bounded tail), not the
    // first `cap`: the terminal JSON block lands at the END of stdout, and a
    // failure's useful stderr (stack trace / OOM line) is its tail. Trimming
    // the front bounds memory without dropping the part we actually need.
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > cap) stdout = stdout.slice(stdout.length - cap);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > cap) stderr = stderr.slice(stderr.length - cap);
    });

    let exited = false;
    let timedOut = false;
    child.on("exit", () => {
      exited = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stopForwarding();
      // Wait for the process itself, not its stdio: a grandchild may keep the
      // pipes open after the CLI is gone. Then for the rest of its group.
      const cliGone = exited ? Promise.resolve() : new Promise<void>((done) => child.once("exit", () => done()));
      signalGroup(group, "SIGKILL");
      void cliGone
        .then(() => killGroup(group))
        .then(() => reject(new Error(`${options.label}: '${options.bin}' did not return within ${options.timeoutMs}ms`)));
    }, options.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      stopForwarding();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `${options.label}: '${options.bin}' not found on PATH — install the coding-agent CLI, or run with --fake-runner (no subprocess)`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      stopForwarding();
      // Anything the CLI left running in the background goes with it.
      void killGroup(group).then(() => {
        if (code !== 0) {
          reject(
            new Error(
              `${options.label}: '${options.bin}' exited with code ${code}; stderr tail: ${redactor.redact(tail(stderr))}`,
            ),
          );
          return;
        }
        resolve({
          responseText: redactor.redact(stdout),
          ...(stderr.length > 0 ? { stderrTail: redactor.redact(tail(stderr)) } : {}),
        });
      });
    });
  });
}

/** How long to wait for a killed group's members to disappear before giving up. */
const GROUP_SETTLE_MS = 5_000;

/** Sends `signal` to process group `group`; false when no live member is left (or it never started). */
function signalGroup(group: number | undefined, signal: NodeJS.Signals | 0): boolean {
  if (group === undefined) return false;
  try {
    process.kill(-group, signal);
    return true;
  } catch (err) {
    // ESRCH: the group is gone. EPERM: macOS's answer for a group of zombies only — all
    // members are our own children's descendants, so nothing live is left to signal.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw err;
  }
}

/** SIGKILLs every process left in `group` and waits until none answers (bounded by `GROUP_SETTLE_MS`). */
export async function killGroup(group: number | undefined): Promise<void> {
  if (!signalGroup(group, "SIGKILL")) return;
  const deadline = Date.now() + GROUP_SETTLE_MS;
  while (signalGroup(group, 0) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
  }
}

const FORWARDED_SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * A detached group doesn't get the terminal's Ctrl-C, so while the CLI runs,
 * a termination signal reaching this process kills the group, then is raised
 * again with the listener gone so this process reacts as it would have.
 * Returns the function that stops forwarding.
 */
export function forwardTerminationSignals(group: number | undefined): () => void {
  const listener = (signal: NodeJS.Signals): void => {
    stop();
    signalGroup(group, "SIGKILL");
    process.kill(process.pid, signal);
  };
  const stop = (): void => {
    for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, listener);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, listener);
  return stop;
}
