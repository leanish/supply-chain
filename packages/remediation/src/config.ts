/**
 * A tool's own configuration, `~/.config/leanish/<tool>/agent.yaml` by
 * default. What's about the repository (release age, own packages,
 * registries) comes from the repository's `.github/supply-chain.json`
 * instead; this file says where the tool works and how:
 *
 *   repos:                       # each an explicit opt-in
 *     - repo: leanish/sqs-codec
 *       branch: main             # optional: the default branch otherwise
 *   agent:
 *     codingAgent: codex         # the only runner that can write today
 *     model: sol
 *     effort: medium
 *     majorEffort: high          # majors and their reviews
 *   secrets:                     # macOS Keychain service names
 *     write: leanish-secure-it-github       # the tool's own token
 *     read: leanish-secure-it-github-read   # the agent's, read-only
 *   commitIdentity: { name: leanish, email: 5417585+leanish@users.noreply.github.com }
 *   dirs: { state: ~/.local/share/leanish/secure-it, cache: ~/.cache/leanish/secure-it }  # optional
 *   readDeny: [~/dev/private]    # optional: paths the agent's commands can't read
 *   modelPrices: ~/.config/leanish/model-prices.json   # optional
 *   staleScanHours: 36           # secure-it only
 *   maxNewMajorsPerRun: 3        # bump-it only: new major PRs one run may open
 *
 * Unknown fields fail, so a typo can't turn something off.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { parse } from "yaml";

import type { GitIdentity } from "../../agent-basics/src/isolation.ts";
import { assertRepoSourceId } from "../../agent-basics/src/types/repo-source.ts";

import type { ToolName } from "./own-pr.ts";

export interface ToolRepo {
  /** `owner/repo`. */
  readonly repo: string;
  /** The branch to work on; undefined: the repository's default branch. */
  readonly branch: string | undefined;
}

export interface ToolConfig {
  readonly tool: ToolName;
  readonly repos: ReadonlyArray<ToolRepo>;
  readonly agent: { readonly codingAgent: "codex"; readonly model: string; readonly effort: string; readonly majorEffort: string };
  readonly secrets: { readonly write: string; readonly read: string };
  readonly commitIdentity: GitIdentity;
  readonly dirs: { readonly state: string; readonly cache: string };
  readonly readDeny: ReadonlyArray<string>;
  readonly modelPrices: string | undefined;
  /** secure-it: how old the default branch's last successful daily scan may be before the run report warns. */
  readonly staleScanHours: number | undefined;
  /** bump-it: how many new major PRs one run may open (updating an open one is never capped). */
  readonly maxNewMajorsPerRun: number | undefined;
}

export function defaultConfigPath(tool: ToolName, home = homedir()): string {
  return join(home, ".config", "leanish", tool, "agent.yaml");
}

/** Parses and validates `text` (the YAML of `where`) for `tool`. */
export function parseToolConfig(tool: ToolName, text: string, where: string, home = homedir()): ToolConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`${where} isn't YAML: ${(err as Error).message}`);
  }
  const root = object(raw, where, ["repos", "agent", "secrets", "commitIdentity", "dirs", "readDeny", "modelPrices", "staleScanHours", "maxNewMajorsPerRun"]);
  const path = (value: unknown, field: string): string => {
    const text = string(value, `${where}: ${field}`);
    const expanded = text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text;
    if (!isAbsolute(expanded)) throw new Error(`${where}: ${field} must be an absolute path (or start with ~/); got '${text}'`);
    return expanded;
  };

  const repos = list(root["repos"], `${where}: repos`).map((entry, i) => {
    const item = object(entry, `${where}: repos[${i}]`, ["repo", "branch"]);
    const repo = string(item["repo"], `${where}: repos[${i}].repo`);
    assertRepoSourceId(repo);
    return { repo, branch: item["branch"] === undefined ? undefined : string(item["branch"], `${where}: repos[${i}].branch`) };
  });
  if (repos.length === 0) throw new Error(`${where}: repos lists no repository; each one is an explicit opt-in`);
  const duplicate = repos.find((entry, i) => repos.findIndex((other) => other.repo.toLowerCase() === entry.repo.toLowerCase()) !== i);
  if (duplicate !== undefined) throw new Error(`${where}: repos lists ${duplicate.repo} twice`);

  const agent = object(root["agent"], `${where}: agent`, ["codingAgent", "model", "effort", "majorEffort"]);
  const codingAgent = string(agent["codingAgent"], `${where}: agent.codingAgent`);
  // Claude Code's runner refuses write access, and both tools write.
  if (codingAgent !== "codex") throw new Error(`${where}: agent.codingAgent must be codex (the only runner that can edit a working copy); got '${codingAgent}'`);
  const secrets = object(root["secrets"], `${where}: secrets`, ["write", "read"]);
  const write = string(secrets["write"], `${where}: secrets.write`);
  const read = string(secrets["read"], `${where}: secrets.read`);
  if (write === read) throw new Error(`${where}: secrets.write and secrets.read must be different items: the agent only gets the read-only one`);
  const identity = object(root["commitIdentity"], `${where}: commitIdentity`, ["name", "email"]);
  const dirs = root["dirs"] === undefined ? {} : object(root["dirs"], `${where}: dirs`, ["state", "cache"]);

  const staleScanHours = root["staleScanHours"];
  if (staleScanHours !== undefined && tool !== "secure-it") throw new Error(`${where}: staleScanHours is secure-it's`);
  if (staleScanHours !== undefined && (typeof staleScanHours !== "number" || !Number.isInteger(staleScanHours) || staleScanHours < 1)) {
    throw new Error(`${where}: staleScanHours must be a positive integer`);
  }

  const maxNewMajorsPerRun = root["maxNewMajorsPerRun"];
  if (maxNewMajorsPerRun !== undefined && tool !== "bump-it") throw new Error(`${where}: maxNewMajorsPerRun is bump-it's`);
  if (maxNewMajorsPerRun !== undefined && (typeof maxNewMajorsPerRun !== "number" || !Number.isInteger(maxNewMajorsPerRun) || maxNewMajorsPerRun < 0)) {
    throw new Error(`${where}: maxNewMajorsPerRun must be a non-negative integer`);
  }

  return {
    tool,
    repos,
    agent: {
      codingAgent: "codex",
      model: string(agent["model"], `${where}: agent.model`),
      effort: string(agent["effort"], `${where}: agent.effort`),
      majorEffort: string(agent["majorEffort"], `${where}: agent.majorEffort`),
    },
    secrets: { write, read },
    commitIdentity: {
      name: string(identity["name"], `${where}: commitIdentity.name`),
      email: string(identity["email"], `${where}: commitIdentity.email`),
    },
    dirs: {
      state: dirs["state"] === undefined ? join(home, ".local", "share", "leanish", tool) : path(dirs["state"], "dirs.state"),
      cache: dirs["cache"] === undefined ? join(home, ".cache", "leanish", tool) : path(dirs["cache"], "dirs.cache"),
    },
    readDeny: root["readDeny"] === undefined ? [] : list(root["readDeny"], `${where}: readDeny`).map((entry, i) => path(entry, `readDeny[${i}]`)),
    modelPrices: root["modelPrices"] === undefined ? undefined : path(root["modelPrices"], "modelPrices"),
    staleScanHours: tool === "secure-it" ? ((staleScanHours as number | undefined) ?? 36) : undefined,
    maxNewMajorsPerRun: tool === "bump-it" ? ((maxNewMajorsPerRun as number | undefined) ?? 3) : undefined,
  };
}

/** The configured entry for `repo`; a repository the config doesn't list is refused (it never opted in). */
export function repoOf(config: ToolConfig, repo: string): ToolRepo {
  const found = config.repos.find((entry) => entry.repo.toLowerCase() === repo.toLowerCase());
  if (found === undefined) throw new Error(`${repo} isn't in ${config.tool}'s repos: each repository opts in explicitly`);
  return found;
}

function object(value: unknown, where: string, allowed: ReadonlyArray<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be a mapping`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${where}: unknown field(s): ${unknown.join(", ")}`);
  return value as Record<string, unknown>;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);
  return value;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where} must be a non-empty string`);
  return value;
}
