// Copied from leanish/leanish-development core/runtime/test/unit/codex-runner-usage.test.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`, its fixtures from `./fixtures/`.
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CodexRunner, type CodexRunnerOptions } from "../src/skill/codex-runner.ts";
import type { SkillInvocation } from "../src/skill/runner.ts";
import { SkillLoader } from "../src/skill/skill-loader.ts";
import type { LoadedSkill } from "../src/skill/skill.ts";
import type { SkillUsage } from "../src/usage/skill-usage.ts";
import { lines, sessionMeta, tokenCount, turnContext, usageRecord } from "./fixtures/codex-rollout.ts";

/**
 * A stub `codex` in Node: `app-server` speaks the JSON-RPC the runner's quota
 * reading uses, `exec` copies prepared rollouts into `$CODEX_HOME/sessions`
 * and answers. Behaviour comes from FAKE_* variables in the runner's env:
 *
 *   FAKE_BASELINE   ok (default) | api-key | hang | refuse
 *   FAKE_PERCENT    the baseline's primary used percent (default 40)
 *   FAKE_ROLLOUTS   directory whose files exec copies into the sessions dir
 *   FAKE_EXEC_EXIT  exec's exit code (default 0); FAKE_EXEC_SLEEP seconds before it exits
 *   FAKE_STATE      directory for the stub's own notes: `home` (exec's CODEX_HOME),
 *                   `server-gone` (written as app-server exits), `calls`
 */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = process.env.FAKE_STATE;
const note = (name, text) => fs.appendFileSync(path.join(state, name), text);
const [command] = process.argv.slice(2);
note("calls", command + "\\n");
const RESET = 1900000000;
if (command === "app-server") {
  const mode = process.env.FAKE_BASELINE || "ok";
  if (mode === "refuse") process.exit(1);
  const percent = Number(process.env.FAKE_PERCENT || 40);
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\\n");
    buffer = parts.pop();
    for (const part of parts) {
      const message = JSON.parse(part);
      if (mode === "hang") continue;
      if (message.id === 1) send({ id: 1, result: {} });
      if (message.id === 2) send({ id: 2, result: { account: mode === "api-key" ? { type: "apiKey" } : { type: "chatgpt", email: null, planType: "team" }, requiresOpenaiAuth: true } });
      if (message.id === 3) {
        if (mode === "api-key") send({ id: 3, error: { message: "no ChatGPT account" } });
        else send({ id: 3, result: { ordinaryUsageAllowed: true, rateLimits: {}, rateLimitsByLimitId: { codex: { limitId: "codex", planType: "team", primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: RESET }, secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: RESET + 500000 } } } } });
      }
    }
  });
  process.stdin.on("end", () => setTimeout(() => { note("server-gone", "yes"); process.exit(0); }, 200));
} else if (command === "exec") {
  fs.writeFileSync(path.join(state, "home"), process.env.CODEX_HOME);
  // The quota reading must be over (its process gone) before exec starts.
  const answered = ["ok", "api-key"].includes(process.env.FAKE_BASELINE || "ok");
  if (answered && !fs.existsSync(path.join(state, "server-gone"))) {
    process.stderr.write("app-server still running\\n");
    process.exit(7);
  }
  const source = process.env.FAKE_ROLLOUTS;
  if (source) {
    const target = path.join(process.env.CODEX_HOME, "sessions", "2026", "01", "01");
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(source)) fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
  const finish = () => {
    process.stdout.write("\`\`\`json\\n{}\\n\`\`\`\\n");
    process.exit(Number(process.env.FAKE_EXEC_EXIT || 0));
  };
  setTimeout(finish, Number(process.env.FAKE_EXEC_SLEEP || 0) * 1000);
} else {
  process.exit(1);
}
`;

let askSkill: LoadedSkill;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-usage-skill-"));
  await mkdir(join(dir, "ask"), { recursive: true });
  await writeFile(join(dir, "ask", "SKILL.md"), "---\nname: ask\ninputSchema: { type: object }\noutputSchema: { type: object }\n---\n\n# ask\n");
  askSkill = await new SkillLoader({ skillsDirs: [dir] }).loadEntrypoint("ask");
});

interface Harness {
  readonly bin: string;
  readonly state: string;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "codex-usage-bin-"));
  const bin = join(dir, "codex");
  await writeFile(bin, STUB);
  await chmod(bin, 0o755);
  const state = join(dir, "state");
  await mkdir(state);
  return { bin, state };
}

async function rolloutsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-usage-rollouts-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

const LIMITS = (usedPercent: number) => ({
  limitId: "codex",
  planType: "team",
  primary: { usedPercent, windowMinutes: 300, resetsAt: 1_900_000_000 },
  secondary: { usedPercent: 71, windowMinutes: 10080, resetsAt: 1_900_500_000 },
});

/** A root on model-sol that spawned one sub-agent on model-luna. */
const ROOT_AND_CHILD = {
  "rollout-1-root.jsonl": lines(
    sessionMeta("root-1"),
    turnContext("model-sol"),
    usageRecord({ threadId: "root-1", turnId: "turn-model-sol", responseId: "r1", usage: { input: 1000, cached: 100, output: 50 } }),
    tokenCount({ input: 1000, cached: 100, output: 50 }, { input: 1000, cached: 100, output: 50 }, LIMITS(42)),
  ),
  "rollout-2-child.jsonl": lines(
    sessionMeta("child-1", "root-1"),
    turnContext("model-luna"),
    usageRecord({ threadId: "child-1", turnId: "turn-model-luna", responseId: "c1", usage: { input: 300, output: 20 } }),
    tokenCount({ input: 300, output: 20 }, { input: 300, output: 20 }, LIMITS(43)),
  ),
};

/** A root whose one response is recorded, with no rate-limit reading. */
const PLAIN = {
  "rollout-root.jsonl": lines(
    sessionMeta("root-1"),
    turnContext("model-sol"),
    usageRecord({ threadId: "root-1", turnId: "turn-model-sol", responseId: "r1", usage: { input: 10, output: 1 } }),
  ),
};

function invocation(onUsage: (usage: SkillUsage) => void, overrides: Partial<SkillInvocation> = {}): SkillInvocation {
  return { entrypoint: askSkill, supportSkills: [], renderedArguments: "x: 1", workingCopies: [], onUsage, ...overrides };
}

async function runWith(
  h: Harness,
  env: Record<string, string>,
  options: Partial<CodexRunnerOptions> = {},
  overrides: Partial<SkillInvocation> = {},
): Promise<{ readonly usages: SkillUsage[]; readonly error?: unknown; readonly homeExistedAtCallback: boolean[] }> {
  const usages: SkillUsage[] = [];
  const homeExistedAtCallback: boolean[] = [];
  const runner = new CodexRunner({ bin: h.bin, suppressFlags: [], env: { FAKE_STATE: h.state, ...env }, ...options });
  const onUsage = (usage: SkillUsage): void => {
    usages.push(usage);
    // Synchronous on purpose: the callback is.
    const home = existsSync(join(h.state, "home")) ? readFileSync(join(h.state, "home"), "utf8") : "";
    homeExistedAtCallback.push(home !== "" && existsSync(home));
  };
  try {
    await runner.run(invocation(onUsage, overrides));
    return { usages, homeExistedAtCallback };
  } catch (error) {
    return { usages, error, homeExistedAtCallback };
  }
}

describe("CodexRunner usage", () => {
  it("reports one frozen snapshot: tokens per model across root and sub-agent, and the quota change", async () => {
    const h = await harness();
    const { usages, error, homeExistedAtCallback } = await runWith(h, {
      FAKE_ROLLOUTS: await rolloutsDir(ROOT_AND_CHILD),
      FAKE_PERCENT: "40",
    });

    expect(error).toBeUndefined();
    expect(usages).toHaveLength(1);
    const usage = usages[0]!;
    expect(Object.isFrozen(usage)).toBe(true);
    expect(Object.isFrozen(usage.models)).toBe(true);
    // Delivered after cleanup: the staged home is gone by then.
    expect(homeExistedAtCallback).toEqual([false]);
    expect(usage).toMatchObject({ codingAgent: "codex", synthetic: false, measurement: "complete", gaps: [] });
    expect(usage.models.map((entry) => [entry.model, entry.tokens.input, entry.tokens.output])).toEqual([
      ["model-luna", 300, 20],
      ["model-sol", 1000, 50],
    ]);
    expect(usage.tokens).toEqual({ input: 1300, cachedInput: 100, cacheWriteInput: 0, output: 70, reasoningOutput: 0, total: 1370 });
    expect(usage.quota).toMatchObject({ status: "observed", approximate: true, planType: "team" });
    const windows = usage.quota.status === "observed" ? usage.quota.windows : [];
    expect(windows.map((w) => [w.window, w.beforePercent, w.afterPercent, w.changePercentPoints])).toEqual([
      ["primary", 40, 43, 3],
      ["secondary", 70, 71, 1],
    ]);
    expect(usage.durationMs).toBeGreaterThanOrEqual(0);
    expect(await readFile(join(h.state, "calls"), "utf8")).toBe("app-server\nexec\n");
  });

  it("attributes the CLI's default model from the session files when the descriptor names none", async () => {
    const { usages } = await runWith(await harness(), { FAKE_ROLLOUTS: await rolloutsDir(ROOT_AND_CHILD) });
    expect(usages[0]?.requestedModel).toBeUndefined();
    expect(usages[0]?.models.map((entry) => entry.model)).toEqual(["model-luna", "model-sol"]);
  });

  it("keeps the usage of a failed run, marked partial", async () => {
    const { usages, error } = await runWith(await harness(), {
      FAKE_ROLLOUTS: await rolloutsDir(ROOT_AND_CHILD),
      FAKE_EXEC_EXIT: "3",
    });
    expect((error as Error).message).toMatch(/exited with code 3/);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ measurement: "partial" });
    expect(usages[0]?.tokens?.input).toBe(1300);
    expect(usages[0]?.gaps[0]).toMatch(/didn't finish normally/);
  });

  it("keeps what a timed-out run recorded, cut-off line included", async () => {
    const cut = `${lines(
      sessionMeta("root-1"),
      turnContext("model-sol"),
      usageRecord({ threadId: "root-1", turnId: "turn-model-sol", responseId: "r1", usage: { input: 500, output: 5 } }),
    )}{"type":"token_usage_re`;
    const { usages, error } = await runWith(
      await harness(),
      { FAKE_ROLLOUTS: await rolloutsDir({ "rollout-root.jsonl": cut }), FAKE_EXEC_SLEEP: "5" },
      { timeoutMs: 1500 },
    );
    expect((error as Error).message).toMatch(/did not return within/);
    expect(usages[0]).toMatchObject({ measurement: "partial" });
    expect(usages[0]?.tokens?.input).toBe(500);
    expect(usages[0]?.gaps.some((gap) => gap.includes("the last line is cut off"))).toBe(true);
  });

  it("runs without a quota baseline when app-server fails, and says so", async () => {
    const { usages, error } = await runWith(await harness(), {
      FAKE_ROLLOUTS: await rolloutsDir(ROOT_AND_CHILD),
      FAKE_BASELINE: "refuse",
    });
    expect(error).toBeUndefined();
    expect(usages[0]?.measurement).toBe("complete");
    expect(usages[0]?.gaps).toEqual([expect.stringMatching(/no quota reading before the run: .*exited without answering/)]);
    const windows = usages[0]?.quota.status === "observed" ? usages[0].quota.windows : [];
    expect(windows.every((w) => w.noChangeReason === "no-reading-before" && w.afterPercent !== undefined)).toBe(true);
  });

  it("bounds the baseline by what's left of the shared timeout", async () => {
    const h = await harness();
    const { usages, error } = await runWith(
      h,
      { FAKE_BASELINE: "hang" },
      { timeoutMs: 1200, quotaBaselineTimeoutMs: 60_000 },
    );
    // The reading used up the budget, so exec never ran: no provider call, zero usage.
    expect((error as Error).message).toMatch(/1200ms invocation budget ran out/);
    expect(await readFile(join(h.state, "calls"), "utf8")).toBe("app-server\n");
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      measurement: "complete",
      tokens: { input: 0, output: 0, total: 0 },
      quota: { status: "not-applicable", reason: "no provider call was made" },
    });
  });

  it("treats an API-key login without rate limits as not drawing on a subscription", async () => {
    const { usages } = await runWith(await harness(), { FAKE_ROLLOUTS: await rolloutsDir(PLAIN), FAKE_BASELINE: "api-key" });
    expect(usages[0]?.quota).toEqual({ status: "not-applicable", reason: "Codex ran with an API-key login, which has no subscription quota" });
    expect(usages[0]?.gaps).toEqual([]);
  });

  it("reports quota as unavailable when a ChatGPT login's run left no rate-limit reading", async () => {
    const { usages } = await runWith(await harness(), { FAKE_ROLLOUTS: await rolloutsDir(PLAIN), FAKE_BASELINE: "refuse" });
    expect(usages[0]?.quota).toEqual({ status: "unavailable" });
    expect(usages[0]?.gaps).toContain("no rate-limit reading, so no quota change");
  });

  it("reports one zero-usage snapshot for a failure before staging", async () => {
    const h = await harness();
    const { usages, error } = await runWith(h, {}, {}, { access: "write" });
    expect((error as Error).message).toMatch(/needs at least one working copy/);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ measurement: "complete", tokens: { total: 0 }, models: [], gaps: [] });
    expect(existsSync(join(h.state, "calls"))).toBe(false);
  });

  it("marks a run without session files partial, with no token counts", async () => {
    const { usages } = await runWith(await harness(), {});
    expect(usages[0]).toMatchObject({ measurement: "partial" });
    expect(usages[0]?.tokens).toBeUndefined();
    expect(usages[0]?.gaps).toContain("Codex left no session file, so its usage is unknown");
  });

  it("keeps a throwing callback from changing the result, the error or the cleanup", async () => {
    const h = await harness();
    const runner = new CodexRunner({ bin: h.bin, suppressFlags: [], env: { FAKE_STATE: h.state, FAKE_ROLLOUTS: await rolloutsDir(ROOT_AND_CHILD) } });
    const throwing = (): void => {
      throw new Error("recorder broke");
    };
    const result = await runner.run(invocation(throwing));
    expect(result.responseText).toContain("```json");
    expect(existsSync(await readFile(join(h.state, "home"), "utf8"))).toBe(false);

    const failing = new CodexRunner({ bin: h.bin, suppressFlags: [], env: { FAKE_STATE: h.state, FAKE_EXEC_EXIT: "4" } });
    await expect(failing.run(invocation(throwing))).rejects.toThrowError(/exited with code 4/);
  });
});
