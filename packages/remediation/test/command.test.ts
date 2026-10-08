import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { FakeCodingAgentRunner } from "../../agent-basics/src/skill/fake-runner.ts";
import type { SkillInvocation } from "../../agent-basics/src/skill/runner.ts";
import { InMemoryWorkspace } from "../../agent-basics/src/working-copy/in-memory-workspace.ts";
import { type Machine, runToolCommand, type ToolHandlers, type ToolRunContext } from "../src/command.ts";

const CONFIG = `
repos:
  - repo: leanish/widget
agent: { codingAgent: codex, model: sol, effort: medium, majorEffort: high }
secrets: { write: tool-write, read: tool-read }
commitIdentity: { name: leanish, email: 5417585+leanish@users.noreply.github.com }
dirs: { state: /tmp/tool-state, cache: /tmp/tool-cache }
`;

const SKILL = `---
name: fix
inputSchema:
  type: object
  properties:
    package: { type: string }
outputSchema:
  type: object
  required: [summary]
  properties:
    summary: { type: string }
---

# fix
`;

let skillsDir: string;

beforeAll(async () => {
  skillsDir = await mkdtemp(join(tmpdir(), "tool-skills-"));
  await mkdir(join(skillsDir, "fix"), { recursive: true });
  await writeFile(join(skillsDir, "fix", "SKILL.md"), SKILL);
});

/** A machine with fakes everywhere; `stderr` collects the log and the final line. */
function machine(overrides: Partial<Machine> & { readonly secretValues?: Record<string, string> } = {}) {
  const stderr = new PassThrough();
  let log = "";
  stderr.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  const invocations: SkillInvocation[] = [];
  const runner = new FakeCodingAgentRunner("codex");
  runner.register("fix", (invocation) => {
    invocations.push(invocation);
    return { responseText: '```json\n{"summary": "fixed"}\n```' };
  });
  const secretValues = overrides.secretValues ?? { "tool-write": "write-token", "tool-read": "read-token" };
  const requested: string[] = [];
  const fake: Partial<Machine> = {
    secrets: {
      async get(name) {
        const value = secretValues[name];
        if (value === undefined) throw new Error(`no Keychain item for service '${name}'`);
        return value;
      },
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requested.push(`${String(url)} ${JSON.stringify(init?.headers)}`);
      return new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 });
    }) as typeof globalThis.fetch,
    stderr,
    now: () => new Date("2026-10-07T05:00:00Z"),
    readText: async (path) => {
      if (path === "/config/agent.yaml") return CONFIG;
      throw new Error(`ENOENT: ${path}`);
    },
    workspace: () => new InMemoryWorkspace(),
    runner: () => runner,
    ...overrides,
  };
  const finalLine = () => JSON.parse(log.trim().split("\n").filter((line) => line.includes('"run finished"')).at(-1)!) as Record<string, unknown>;
  return { fake, finalLine, invocations, requested, log: () => log };
}

function handlers(run: (context: ToolRunContext) => Promise<Readonly<Record<string, unknown>>>): ToolHandlers {
  return {
    tool: "secure-it",
    skills: { dirs: [skillsDir], entrypoints: ["fix"], support: [] },
    run,
    review: async () => ({ reviewed: [] }),
  };
}

describe("runToolCommand", () => {
  it.each([undefined, "/config/prices.json"])("prices measured calls using built-in rates or the explicit override %s", async (priceFile) => {
    const tokens = { input: 1_000, cachedInput: 0, cacheWriteInput: 0, output: 100, reasoningOutput: 0, total: 1_100 };
    const configured = { inputPerMTok: 1, cachedInputPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 1, basis: "test", source: "test", asOf: "2026-10-07" };
    const { fake, finalLine } = machine({
      readText: async (path) => path === "/config/agent.yaml"
        ? CONFIG + (priceFile === undefined ? "" : `modelPrices: ${priceFile}\n`)
        : JSON.stringify({ "gpt-6.1-sol": configured }),
      runner: () => ({ codingAgent: "codex", async run(invocation) {
        invocation.onUsage?.({
          codingAgent: "codex", durationMs: 1, synthetic: false, measurement: "complete", tokens,
          models: [{ model: "gpt-6.1-sol", tokens, requests: [{ tokens, exact: true }] }],
          quota: { status: "unavailable" }, gaps: [],
        });
        return { responseText: '```json\n{"summary":"fixed"}\n```' };
      } }),
    });
    await runToolCommand(handlers(async (context) => { await context.agent({ entrypoint: "fix", input: { package: "lib" } }); return {}; }), ["run", "leanish/widget", "--config", "/config/agent.yaml"], fake);
    expect(finalLine()).toMatchObject({ totals: { estimatedApiCostUsd: priceFile === undefined ? 0.003 : 0.0011, gaps: [] } });
  });

  it.each(["secure-it", "bump-it"] as const)("uses %s's default Keychain services and gives only the read token to the agent", async (tool) => {
    const defaults = { [`leanish-${tool}-write`]: "write-token", [`leanish-${tool}-read`]: "read-token" };
    const { fake, invocations, requested } = machine({
      readText: async () => CONFIG.replace(/^secrets:.*\n/m, ""),
      secretValues: defaults,
    });
    const toolHandlers = {
      ...handlers(async (context) => {
        await context.agent({ entrypoint: "fix", input: { package: "vite" } });
        return {};
      }),
      tool,
    };

    expect(await runToolCommand(toolHandlers, ["run", "leanish/widget", "--config", "/config/agent.yaml"], fake)).toBe(0);
    expect(requested[0]).toContain("Bearer write-token");
    expect(invocations[0]?.env?.["GH_TOKEN"]).toBe("read-token");
    expect(JSON.stringify(invocations[0]?.env)).not.toContain("write-token");
  });

  it.each(["secure-it", "bump-it"] as const)("refuses identical token values in %s's default items", async (tool) => {
    const { fake, finalLine } = machine({
      readText: async () => CONFIG.replace(/^secrets:.*\n/m, ""),
      secretValues: { [`leanish-${tool}-write`]: "same-token", [`leanish-${tool}-read`]: "same-token" },
    });
    let ran = false;
    const toolHandlers = {
      ...handlers(async () => {
        ran = true;
        return {};
      }),
      tool,
    };

    expect(await runToolCommand(toolHandlers, ["run", "leanish/widget", "--config", "/config/agent.yaml"], fake)).toBe(1);
    expect(finalLine()).toMatchObject({ error: expect.stringContaining("hold the same token") });
    expect(ran).toBe(false);
  });

  it("allows both tools to use the same explicit pair of Keychain items", async () => {
    for (const tool of ["secure-it", "bump-it"] as const) {
      const { fake } = machine();
      expect(await runToolCommand({ ...handlers(async () => ({})), tool }, ["run", "leanish/widget", "--config", "/config/agent.yaml"], fake)).toBe(0);
    }
  });

  it("wires a run: default branch, working copy, the agent with the read-only token, and the result in the final line", async () => {
    const { fake, finalLine, invocations, requested } = machine();
    let seen: ToolRunContext | undefined;
    const code = await runToolCommand(
      handlers(async (context) => {
        seen = context;
        const answer = await context.agent<{ package: string }, { summary: string }>({ entrypoint: "fix", input: { package: "vite" } });
        return { pullRequest: "https://github.com/leanish/widget/pull/7", summary: answer.summary };
      }),
      ["run", "leanish/widget", "--config", "/config/agent.yaml"],
      fake,
    );
    expect(code).toBe(0);
    expect(seen?.base).toBe("trunk");
    expect(seen?.releaseAgeDays).toBe(7);
    expect(seen?.releaseAgeExclude).toEqual([]);
    expect(seen?.readToken).toBe("read-token");
    expect(seen?.isolation.env?.["npm_config_min_release_age"]).toBe("7");
    expect(seen?.isolation.env?.["PATH"]).toContain("agent-basics/guard");
    expect(JSON.stringify({ ...seen, github: undefined, workspace: undefined, agent: undefined })).not.toContain("write-token");
    expect(requested).toEqual([expect.stringContaining("https://api.github.com/repos/leanish/widget")]);
    expect(requested[0]).toContain("Bearer write-token");
    expect(invocations[0]).toMatchObject({ access: "write", model: "sol", effort: "medium", env: { GH_TOKEN: "read-token" } });
    expect(JSON.stringify(invocations[0]?.env)).not.toContain("write-token");
    expect(finalLine()).toMatchObject({
      msg: "run finished",
      tool: "secure-it",
      repo: "leanish/widget",
      status: "ok",
      exitCode: 0,
      result: { pullRequest: "https://github.com/leanish/widget/pull/7", summary: "fixed" },
      totals: { skillRuns: 1 },
    });
  });

  it("refuses bad arguments, an unlisted repository and identical tokens, always ending with the final line", async () => {
    const bad = machine();
    expect(await runToolCommand(handlers(async () => ({})), ["fix", "leanish/widget"], bad.fake)).toBe(64);
    expect(bad.finalLine()).toMatchObject({ status: "error", exitCode: 64, error: "usage: secure-it run|review <owner/repo> [--config <agent.yaml>]" });

    const unlisted = machine();
    expect(await runToolCommand(handlers(async () => ({})), ["run", "leanish/other", "--config", "/config/agent.yaml"], unlisted.fake)).toBe(1);
    expect(unlisted.finalLine()).toMatchObject({ status: "error", repo: "leanish/other", error: expect.stringContaining("opts in explicitly") });

    const same = machine({ secretValues: { "tool-write": "token", "tool-read": "token" } });
    expect(await runToolCommand(handlers(async () => ({})), ["run", "leanish/widget", "--config", "/config/agent.yaml"], same.fake)).toBe(1);
    expect(same.finalLine()).toMatchObject({ error: expect.stringContaining("hold the same token") });
    expect(same.log()).not.toContain('"token"');
  });

  it("reports a failing run as an error with its message, and runs review on `review`", async () => {
    const failing = machine();
    expect(
      await runToolCommand(
        handlers(async () => {
          throw new Error("compare failed after the change");
        }),
        ["run", "leanish/widget", "--config", "/config/agent.yaml"],
        failing.fake,
      ),
    ).toBe(1);
    expect(failing.finalLine()).toMatchObject({ status: "error", exitCode: 1, error: "compare failed after the change" });

    const reviewing = machine();
    expect(await runToolCommand(handlers(async () => ({})), ["review", "leanish/widget", "--config", "/config/agent.yaml"], reviewing.fake)).toBe(0);
    expect(reviewing.finalLine()).toMatchObject({ status: "ok", result: { reviewed: [] } });
  });

  it("tells run.sh it reported only once the final line is out, and reports even when the marker can't be written", async () => {
    const marker = join(skillsDir, "marker");
    const tracked = machine({ reportMarker: marker });
    let seenDuringRun: boolean | undefined;
    const listeners = process.listenerCount("SIGTERM");
    expect(
      await runToolCommand(
        handlers(async () => {
          seenDuringRun = existsSync(marker);
          return {};
        }),
        ["run", "leanish/widget", "--config", "/config/agent.yaml"],
        tracked.fake,
      ),
    ).toBe(0);
    expect(seenDuringRun).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("reported\n");
    expect(tracked.finalLine()).toMatchObject({ status: "ok" });

    const unwritable = machine({ reportMarker: join(skillsDir, "no-such-dir", "marker") });
    expect(await runToolCommand(handlers(async () => ({})), ["run", "leanish/widget", "--config", "/config/agent.yaml"], unwritable.fake)).toBe(0);
    expect(unwritable.finalLine()).toMatchObject({ status: "ok" });
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  });

  it("writes the final line and then the marker when a signal stops the run", async () => {
    const marker = join(skillsDir, "signal-marker");
    const fixture = fileURLToPath(new URL("./fixtures/command-on-signal.ts", import.meta.url));
    const child = spawn(process.execPath, [fixture, marker], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    const waiting = new Promise<void>((ready) =>
      child.stderr.on("data", (chunk: Buffer) => {
        log += chunk.toString("utf8");
        if (log.includes("waiting to be killed")) ready();
      }),
    );
    const exited = new Promise<NodeJS.Signals | null>((done) => child.on("exit", (_code, signal) => done(signal)));
    await waiting;
    expect(existsSync(marker)).toBe(false);
    child.kill("SIGTERM");
    expect(await exited).toBe("SIGTERM");
    const finals = log.split("\n").filter((line) => line.includes('"run finished"'));
    expect(finals.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ status: "interrupted", exitCode: 143, tool: "secure-it" })]);
    expect(readFileSync(marker, "utf8")).toBe("reported\n");
  }, 20_000);
});
