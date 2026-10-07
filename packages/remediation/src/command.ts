/**
 * The command around one run of a tool: `<tool> run|review <owner/repo>
 * [--config <file>]`. It reads the config (the repository must be listed),
 * the two tokens from the config's resolved per-tool Keychain services
 * (defaults or explicit overrides; the write one for the tool's own
 * GitHub calls, clone and push; the read-only one, the only credential the
 * agent's commands get), syncs the working copy, wires the isolated coding
 * agent, hands everything to the tool's `run` or `review`, and always ends with
 * the `run finished` line on stderr, interruptions included.
 */
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";

import { createGitHubClient } from "../../agent-basics/src/github/github-client.ts";
import { codexIsolation } from "../../agent-basics/src/isolation.ts";
import type { CodexRunnerOptions } from "../../agent-basics/src/skill/codex-runner.ts";
import { ConsoleLogger } from "../../agent-basics/src/logger/console-logger.ts";
import { reportOnTerminationSignals, RunReport, writeFinalLine } from "../../agent-basics/src/report/run-report.ts";
import { CodexRunner } from "../../agent-basics/src/skill/codex-runner.ts";
import { runSkill } from "../../agent-basics/src/skill/run-skill.ts";
import type { CodingAgentRunner } from "../../agent-basics/src/skill/runner.ts";
import { SkillLoader } from "../../agent-basics/src/skill/skill-loader.ts";
import { SchemaValidator } from "../../agent-basics/src/skill/validator.ts";
import { KeychainStore, type SecretStore } from "../../agent-basics/src/secret-store.ts";
import type { GitHubClient } from "../../agent-basics/src/types/clients.ts";
import type { Logger } from "../../agent-basics/src/types/logger.ts";
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { parseModelPrices } from "../../agent-basics/src/usage/model-prices.ts";
import { gitCloneAuth } from "../../agent-basics/src/working-copy/git-clone-auth.ts";
import { LocalGitWorkspace } from "../../agent-basics/src/working-copy/local-git-workspace.ts";
import type { Workspace } from "../../agent-basics/src/working-copy/workspace.ts";
import { readSettings } from "../../ci/src/gate.ts";
import { workingTree } from "../../ci/src/tree.ts";

import { defaultConfigPath, parseToolConfig, repoOf, type ToolConfig, type ToolRepo } from "./config.ts";
import type { ToolName } from "./own-pr.ts";

const GUARD_DIR = fileURLToPath(new URL("../../agent-basics/guard", import.meta.url));

/** What a tool's `run` or `review` gets. */
export interface ToolRunContext {
  readonly config: ToolConfig;
  readonly repo: ToolRepo;
  /** The branch the tool works against: the configured one, else the repository's default branch. */
  readonly base: string;
  readonly github: GitHubClient;
  readonly workspace: Workspace;
  readonly workingCopy: WorkingCopy;
  readonly logger: Logger;
  readonly now: Date;
  /** The repository's release age, from its `.github/supply-chain.json`. */
  readonly releaseAgeDays: number;
  /** npm patterns exempt from it: the repository's own scopes (`@scope/*`), whose young versions resolve anyway. */
  readonly releaseAgeExclude: ReadonlyArray<string>;
  /** The agent's read-only token: for the gate's own GitHub reads (advisories, actions), never for writes. */
  readonly readToken: string;
  /** How the agent is isolated; `runSandboxed` runs repository code the same way. */
  readonly isolation: CodexRunnerOptions;
  /** Runs one of the tool's skills on the working copy, with write access and the read-only token. */
  readonly agent: <TInput, TOutput>(call: { readonly entrypoint: string; readonly input: TInput; readonly effort?: string }) => Promise<TOutput>;
}

export interface ToolHandlers {
  readonly tool: ToolName;
  /** Where the tool's skills live, its entrypoints, and the support skills staged with each. */
  readonly skills: { readonly dirs: ReadonlyArray<string>; readonly entrypoints: ReadonlyArray<string>; readonly support: ReadonlyArray<string> };
  run(context: ToolRunContext): Promise<Readonly<Record<string, unknown>>>;
  review(context: ToolRunContext): Promise<Readonly<Record<string, unknown>>>;
}

/** The machine a command runs on; each defaults to the real one, tests replace them. */
export interface Machine {
  readonly secrets: SecretStore;
  readonly fetch: typeof globalThis.fetch;
  readonly stderr: NodeJS.WritableStream;
  readonly now: () => Date;
  readonly readText: (path: string) => Promise<string>;
  readonly workspace: (root: string, token: string, config: ToolConfig) => Workspace;
  readonly runner: (isolation: CodexRunnerOptions) => CodingAgentRunner;
  /** run.sh's marker file (`TOOL_REPORT_MARKER`): written once the final line is out, so run.sh doesn't write one too. */
  readonly reportMarker: string | undefined;
}

export const USAGE = (tool: ToolName) => `usage: ${tool} run|review <owner/repo> [--config <agent.yaml>]`;

/** Runs the command `argv` describes; resolves to its exit code once the final line is written. */
export async function runToolCommand(handlers: ToolHandlers, argv: ReadonlyArray<string>, machine: Partial<Machine> = {}): Promise<number> {
  const m: Machine = { ...defaultMachine(), ...machine };
  const report = new RunReport();
  // The final line goes through this stream, on the normal path and on a signal's: it tells run.sh once the line is out.
  const finalLines = acknowledging(m.stderr, m.reportMarker);
  let stopReporting: () => void = () => undefined;
  const finish = async (exitCode: number, status: "ok" | "error", extra: { error?: string; result?: Readonly<Record<string, unknown>> } = {}) => {
    stopReporting();
    const line = report.finish({ status, exitCode, ...extra });
    if (line !== undefined) await writeFinalLine(finalLines, line);
    return exitCode;
  };
  try {
    stopReporting = reportOnTerminationSignals(report, finalLines);
  } catch (err) {
    return finish(70, "error", { error: `couldn't start reporting: ${(err as Error).message}` });
  }

  let command: string;
  let repoName: string;
  let configPath: string;
  try {
    const { values, positionals } = parseArgs({ args: [...argv], options: { config: { type: "string" } }, allowPositionals: true, strict: true });
    if (positionals.length !== 2 || (positionals[0] !== "run" && positionals[0] !== "review")) throw new Error(USAGE(handlers.tool));
    [command, repoName] = positionals as [string, string];
    configPath = values.config ?? defaultConfigPath(handlers.tool);
  } catch (err) {
    return finish(64, "error", { error: (err as Error).message });
  }

  report.identified(handlers.tool, repoName);
  const logger = new ConsoleLogger({ minLevel: "info", stream: m.stderr }).with({ tool: handlers.tool, repo: repoName, command });
  try {
    const config = parseToolConfig(handlers.tool, await m.readText(configPath), configPath);
    const repo = repoOf(config, repoName);
    const write = await m.secrets.get(config.secrets.write);
    const read = await m.secrets.get(config.secrets.read);
    if (write === read) throw new Error(`${config.secrets.write} and ${config.secrets.read} hold the same token: the agent would get the write one`);
    const github = createGitHubClient({ env: { GITHUB_TOKEN: write }, fetch: m.fetch });
    const base = repo.branch ?? (await defaultBranch(repo.repo, write, m.fetch));
    const workspace = m.workspace(join(config.dirs.state, "workspaces"), write, config);
    const synced = await workspace.sync([{ id: repo.repo, source: { url: `https://github.com/${repo.repo}.git`, branch: base } }]);
    const workingCopy = synced.workingCopies[0]!;
    const { config: repoConfig } = await readSettings(workingTree(workingCopy.path));
    const releaseAgeExclude = repoConfig.ownPackages.npmScopes.map((scope) => `${scope}/*`);
    const isolation = codexIsolation({
      commitIdentity: config.commitIdentity,
      readDeny: config.readDeny,
      commandPath: [GUARD_DIR],
      releaseAgeDays: repoConfig.releaseAgeDays,
      releaseAgeExclude,
      buildCacheRoot: config.dirs.cache,
    });
    const runner = m.runner(isolation);
    const prices = config.modelPrices === undefined ? undefined : parseModelPrices(JSON.parse(await m.readText(config.modelPrices)), config.modelPrices);
    const skillContext = {
      entrypoints: handlers.skills.entrypoints,
      supportSkills: handlers.skills.support,
      skillLoader: new SkillLoader({ skillsDirs: handlers.skills.dirs }),
      runnerFor: (codingAgent: string) => {
        if (codingAgent !== runner.codingAgent) throw new Error(`no ${codingAgent} runner`);
        return runner;
      },
      validator: new SchemaValidator(),
      logger,
      usageRecorder: report.usageRecorder,
      ...(prices === undefined ? {} : { modelPrices: prices }),
    };
    const context: ToolRunContext = {
      config,
      repo,
      base,
      github,
      workspace,
      workingCopy,
      logger,
      now: m.now(),
      releaseAgeDays: repoConfig.releaseAgeDays,
      releaseAgeExclude,
      readToken: read,
      isolation,
      agent: (call) =>
        runSkill(skillContext, {
          entrypoint: call.entrypoint,
          input: call.input,
          workingCopies: [workingCopy],
          codingAgent: config.agent.codingAgent,
          model: config.agent.model,
          effort: call.effort ?? config.agent.effort,
          access: "write",
          credentials: { env: { GH_TOKEN: read }, secrets: [{ name: "GH_TOKEN", value: read }] },
        }),
    };
    const result = command === "run" ? await handlers.run(context) : await handlers.review(context);
    return finish(0, "ok", { result });
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`${handlers.tool} ${command} failed`, { error: message });
    return finish(1, "error", { error: message });
  }
}

/**
 * `out`, which writes run.sh's marker right after a `run finished` line went
 * through. Writing it is best effort: if it fails, run.sh writes its own line
 * as well, a duplicate rather than none.
 */
function acknowledging(out: NodeJS.WritableStream, marker: string | undefined): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      out.write(chunk, (err) => {
        if ((err === undefined || err === null) && marker !== undefined && marker !== "" && chunk.toString("utf8").includes('"msg":"run finished"')) {
          try {
            // Synchronous: on a signal, the process dies right after this callback.
            writeFileSync(marker, "reported\n");
          } catch {
            // run.sh reports instead (see above).
          }
        }
        callback(err ?? null);
      });
    },
  });
}

/** The repository's default branch, read with the tool's token. */
async function defaultBranch(repo: string, token: string, fetch: typeof globalThis.fetch): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`reading ${repo}'s default branch failed (HTTP ${response.status})`);
  const branch = ((await response.json()) as { default_branch?: unknown }).default_branch;
  if (typeof branch !== "string" || branch === "") throw new Error(`GitHub named no default branch for ${repo}`);
  return branch;
}

function defaultMachine(): Machine {
  return {
    secrets: new KeychainStore(),
    fetch: globalThis.fetch,
    stderr: process.stderr,
    now: () => new Date(),
    readText: (path) => readFile(path, "utf8"),
    reportMarker: process.env["TOOL_REPORT_MARKER"],
    workspace: (root, token, config) => new LocalGitWorkspace({ workspaceRoot: root, gitAuth: gitCloneAuth(token), commitIdentity: config.commitIdentity }),
    runner: (isolation) => new CodexRunner(isolation),
  };
}
