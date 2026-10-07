import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

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
});
