// Copied from leanish/leanish-development core/runtime/test/unit/codex-rollouts.test.ts at e4f8a1e; see PROVENANCE.md.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseRollouts, readRolloutFiles } from "../src/skill/codex-rollouts.ts";
import { UNATTRIBUTED_MODEL } from "../src/usage/skill-usage.ts";
import {
  lines,
  ROLLOUT_SHAPE_VERSIONS,
  sessionMeta,
  tokenCount,
  tokenCountWithNullUsage,
  type Tokens,
  turnContext,
  usageRecord,
} from "./fixtures/codex-rollout.ts";

const CODEX_LIMITS = (usedPercent: number) => ({
  limitId: "codex",
  planType: "team",
  primary: { usedPercent, windowMinutes: 300, resetsAt: 1_900_000_000 },
  secondary: { usedPercent: usedPercent + 10, windowMinutes: 10080, resetsAt: 1_900_500_000 },
});

/** Readings and records agree; `r` builds one response's record in `thread`, turn `turn-<model>`. */
const r = (thread: string, model: string, responseId: string, usage: Tokens, threadTotal?: Tokens) =>
  usageRecord({ threadId: thread, turnId: `turn-${model}`, responseId, usage, ...(threadTotal !== undefined ? { threadTotal } : {}) });

describe.each(ROLLOUT_SHAPE_VERSIONS)("parseRollouts (codex-cli %s shape)", (version) => {
  it("adds a root session and its sub-agents from their usage records, per model, without counting the readings again", () => {
    const root = lines(
      sessionMeta("root-1", undefined, version),
      turnContext("model-sol"),
      tokenCount(null, null, CODEX_LIMITS(10)), // a rate-limit-only reading opens the turn
      r("root-1", "model-sol", "resp-1", { input: 1000, cached: 200, output: 100 }),
      tokenCount({ input: 1000, cached: 200, output: 100 }, { input: 1000, cached: 200, output: 100 }, CODEX_LIMITS(11)),
      tokenCount({ input: 1000, cached: 200, output: 100 }, { input: 1000, cached: 200, output: 100 }), // repeated reading
      r("root-1", "model-sol", "resp-2", { input: 2000, cached: 1000, output: 50 }, { input: 3000, cached: 1200, output: 150 }),
      tokenCount({ input: 3000, cached: 1200, output: 150 }, { input: 2000, cached: 1000, output: 50 }, CODEX_LIMITS(12)),
      // A last response the readings never caught up with: the records still count it.
      r("root-1", "model-sol", "resp-3", { input: 400, output: 4 }, { input: 3400, cached: 1200, output: 154 }),
    );
    const child = lines(
      sessionMeta("child-1", "root-1", version),
      turnContext("model-luna"),
      r("child-1", "model-luna", "resp-c1", { input: 500, output: 40, reasoning: 10 }),
      tokenCount({ input: 500, output: 40, reasoning: 10 }, { input: 500, output: 40, reasoning: 10 }),
    );
    // A sub-agent with usage records and no cumulative reading at all (seen in real sessions).
    const grandchild = lines(
      sessionMeta("grandchild-1", "child-1", version),
      turnContext("model-luna"),
      r("grandchild-1", "model-luna", "resp-g1", { input: 70, output: 7 }),
    );

    const usage = parseRollouts(
      [
        { name: "a.jsonl", content: root },
        { name: "b.jsonl", content: child },
        { name: "c.jsonl", content: grandchild },
      ],
      undefined,
    );

    expect(usage.gaps).toEqual([]);
    expect(usage.clean).toBe(true);
    expect(usage.sessions).toBe(3);
    expect(usage.models.map((entry) => [entry.model, entry.tokens.input, entry.tokens.output, entry.requests.length])).toEqual([
      ["model-luna", 570, 47, 2],
      ["model-sol", 3400, 154, 3],
    ]);
    const sol = usage.models.find((entry) => entry.model === "model-sol")!;
    expect(sol.tokens).toEqual({ input: 3400, cachedInput: 1200, cacheWriteInput: 0, output: 154, reasoningOutput: 0, total: 3554 });
    expect(sol.requests.map((request) => [request.tokens.input, request.exact])).toEqual([
      [1000, true],
      [2000, true],
      [400, true],
    ]);
    expect(usage.rateLimits).toEqual([
      {
        limitId: "codex",
        planType: "team",
        windows: [
          { window: "primary", usedPercent: 12, windowMinutes: 300, resetsAt: 1_900_000_000 },
          { window: "secondary", usedPercent: 22, windowMinutes: 10080, resetsAt: 1_900_500_000 },
        ],
      },
    ]);
  });
});

describe("parseRollouts with usage records", () => {
  it("attributes each record to its turn's model when a session switches models", () => {
    const content = lines(
      sessionMeta("root-1"),
      turnContext("model-sol", "turn-1"),
      usageRecord({ threadId: "root-1", turnId: "turn-1", responseId: "a", usage: { input: 100, output: 10 } }),
      turnContext("model-astra", "turn-2"),
      usageRecord({ threadId: "root-1", turnId: "turn-2", responseId: "b", usage: { input: 200, output: 20 }, threadTotal: { input: 300, output: 30 } }),
    );
    const usage = parseRollouts([{ name: "a", content }], undefined);
    expect(usage.models.map((entry) => [entry.model, entry.tokens.input])).toEqual([
      ["model-astra", 200],
      ["model-sol", 100],
    ]);
    expect(usage.gaps).toEqual([]);
  });

  it("counts a response recorded twice once", () => {
    const content = lines(sessionMeta("root-1"), turnContext("m"), r("root-1", "m", "a", { input: 100, output: 1 }), r("root-1", "m", "a", { input: 100, output: 1 }));
    expect(parseRollouts([{ name: "a", content }], undefined).models[0]?.tokens.input).toBe(100);
  });

  it("counts a record of an unknown turn, unattributed: the tokens are complete, their model (and so their cost) isn't", () => {
    const content = lines(sessionMeta("root-1"), turnContext("m"), usageRecord({ threadId: "root-1", turnId: "turn-gone", responseId: "a", usage: { input: 100, output: 1 } }));
    const usage = parseRollouts([{ name: "a", content }], "m");
    expect(usage.clean).toBe(true);
    expect(usage.models.map((entry) => [entry.model, entry.tokens.input])).toEqual([[UNATTRIBUTED_MODEL, 100]]);
    expect(usage.gaps).toEqual(["1 request(s) belong to a turn that names no model, so their tokens can't be tied to a model or priced"]);
  });

  it.each([
    [
      "records that don't add up to the thread's running total",
      [r("root-1", "m", "a", { input: 100, output: 1 }, { input: 150, output: 1 })],
      "a: the usage records add up to 101 tokens but the thread's running total says 151",
    ],
    [
      "readings showing more than the records",
      [r("root-1", "m", "a", { input: 100, output: 1 }), tokenCount({ input: 300, output: 3 }, { input: 200, output: 2 })],
      "a: the cumulative readings show 303 tokens, more than the 101 the usage records add up to",
    ],
    [
      "a record of another thread",
      [r("root-1", "m", "a", { input: 100, output: 1 }), r("elsewhere", "m", "b", { input: 5, output: 1 })],
      "a: line 4 has a usage record of another thread, not counted",
    ],
    [
      "a record without a valid usage",
      [r("root-1", "m", "a", { input: 100, output: 1 }), JSON.stringify({ type: "token_usage_record", payload: { thread_id: "root-1", usage: null } })],
      "a: line 4 has a usage record without a valid usage",
    ],
  ])("marks the tokens partial for %s", (_case, events, gap) => {
    const usage = parseRollouts([{ name: "a", content: lines(sessionMeta("root-1"), turnContext("m"), ...events) }], undefined);
    expect(usage.clean).toBe(false);
    expect(usage.gaps).toContain(gap);
    expect(usage.models[0]?.tokens.input).toBe(100);
  });
});

describe("parseRollouts from cumulative readings only", () => {
  const READINGS_ONLY = "a: only cumulative readings, no per-request usage records, and readings alone have been seen to miss requests";

  it("counts the readings' growth per request, as partial", () => {
    const content = lines(
      sessionMeta("root-1"),
      turnContext("model-sol"),
      tokenCount({ input: 100, output: 10 }, { input: 100, output: 10 }),
      tokenCount({ input: 100, output: 10 }, { input: 100, output: 10 }), // repeated reading
      turnContext("model-astra"),
      tokenCount({ input: 300, output: 30 }, { input: 200, output: 20 }),
    );
    const usage = parseRollouts([{ name: "a", content }], undefined);
    expect(usage.models.map((entry) => [entry.model, entry.tokens.input])).toEqual([
      ["model-astra", 200],
      ["model-sol", 100],
    ]);
    expect(usage.clean).toBe(false);
    expect(usage.gaps).toEqual([READINGS_ONLY]);
  });

  it("keeps a folded reading's model when no switch happened, and leaves it unattributed across a switch", () => {
    const sameModel = lines(
      sessionMeta("root-1"),
      turnContext("m"),
      tokenCount({ input: 100, output: 10 }, { input: 100, output: 10 }),
      tokenCount({ input: 400, output: 40 }, { input: 150, output: 15 }),
    );
    const requests = parseRollouts([{ name: "a", content: sameModel }], undefined).models[0]!.requests;
    expect(requests.map((request) => [request.tokens.input, request.exact])).toEqual([
      [100, true],
      [300, false],
    ]);

    const acrossSwitch = lines(
      sessionMeta("root-1"),
      turnContext("model-sol"),
      tokenCount({ input: 100, output: 10 }, { input: 100, output: 10 }),
      turnContext("model-astra"),
      tokenCount({ input: 400, output: 40 }, { input: 150, output: 15 }),
    );
    const usage = parseRollouts([{ name: "a", content: acrossSwitch }], undefined);
    expect(usage.models.map((entry) => [entry.model, entry.tokens.input])).toEqual([
      ["model-sol", 100],
      [UNATTRIBUTED_MODEL, 300],
    ]);
    expect(usage.gaps).toContain(
      "1 request(s) fold several requests across a model switch, so their tokens can't be tied to a model or priced",
    );
  });

  it("falls back to the runner's model before any turn names one, and leaves it unattributed without either", () => {
    const content = lines(sessionMeta("root-1"), tokenCount({ input: 100, output: 10 }, { input: 100, output: 10 }));
    expect(parseRollouts([{ name: "a", content }], "model-passed").models.map((entry) => entry.model)).toEqual(["model-passed"]);

    const usage = parseRollouts([{ name: "a", content }], undefined);
    expect(usage.models.map((entry) => entry.model)).toEqual([UNATTRIBUTED_MODEL]);
    expect(usage.gaps).toContain("1 request(s) came before any turn named its model, so their tokens can't be tied to a model or priced");
  });

  it("turns a malformed line, a reading without usable usage and a dropping counter into gaps", () => {
    const content = lines(
      sessionMeta("root-1"),
      turnContext("m"),
      "not json",
      tokenCountWithNullUsage(),
      tokenCount({ input: 100, output: 10 }, { input: 100, output: 10 }),
      tokenCount({ input: 50, output: 5 }, { input: 50, output: 5 }),
      tokenCount({ input: 80, output: 8 }, { input: 30, output: 3 }),
    );
    const usage = parseRollouts([{ name: "a", content }], undefined);
    expect(usage.clean).toBe(false);
    expect(usage.gaps).toEqual([
      "a: line 3 is not JSON",
      "a: line 4 has a token reading without a valid cumulative usage",
      "a: line 6: the cumulative usage went down; the requests before it are counted, the drop isn't",
      READINGS_ONLY,
    ]);
    // 100 before the drop, then the 30 the counter grew by after it.
    expect(usage.models[0]?.tokens.input).toBe(130);
  });
});

describe("parseRollouts", () => {
  it("counts what precedes a cut-off last line and marks the result unclean", () => {
    const content = `${lines(sessionMeta("root-1"), turnContext("m"), r("root-1", "m", "a", { input: 100, output: 10 }))}{"timestamp":"2026-01-01T00:00:09.000Z","type":"token_usage_re`;
    const usage = parseRollouts([{ name: "a.jsonl", content }], undefined);
    expect(usage.models[0]?.tokens.input).toBe(100);
    expect(usage.clean).toBe(false);
    expect(usage.gaps).toEqual(["a.jsonl: the last line is cut off (Codex stopped mid-write)"]);
  });

  it("reports no session file as unknown usage", () => {
    const usage = parseRollouts([], undefined);
    expect(usage).toMatchObject({ models: [], sessions: 0, clean: false, gaps: ["Codex left no session file, so its usage is unknown"] });
  });

  it("reports a session that made no request as zero, clean", () => {
    const usage = parseRollouts([{ name: "a", content: lines(sessionMeta("root-1"), turnContext("m")) }], undefined);
    expect(usage).toMatchObject({ models: [], sessions: 1, clean: true, gaps: [] });
  });

  it("counts nothing when there's no single root", () => {
    const twoRoots = parseRollouts(
      [
        { name: "a", content: lines(sessionMeta("root-1"), r("root-1", "m", "a", { input: 1, output: 1 })) },
        { name: "b", content: lines(sessionMeta("root-2"), r("root-2", "m", "b", { input: 1, output: 1 })) },
      ],
      "m",
    );
    expect(twoRoots).toMatchObject({ models: [], sessions: 0, clean: false });
    expect(twoRoots.gaps).toEqual(["2 root sessions among Codex's session files where one was expected, so none is counted"]);

    const orphanOnly = parseRollouts([{ name: "a", content: lines(sessionMeta("child-1", "gone")) }], "m");
    expect(orphanOnly.gaps).toEqual(["no root session (one without a parent) among Codex's session files, so none is counted"]);
  });

  it("leaves out a session that doesn't descend from the root", () => {
    const usage = parseRollouts(
      [
        { name: "a", content: lines(sessionMeta("root-1"), turnContext("m"), r("root-1", "m", "a", { input: 10, output: 1 })) },
        { name: "b", content: lines(sessionMeta("stray-1", "elsewhere"), turnContext("m"), r("stray-1", "m", "b", { input: 99, output: 9 })) },
      ],
      undefined,
    );
    expect(usage.models[0]?.tokens.input).toBe(10);
    expect(usage.sessions).toBe(1);
    expect(usage.gaps).toEqual(["1 session file(s) don't descend from the root session and weren't counted"]);
  });

  it("takes the latest valid reading of each bucket across sessions, independently of the usage", () => {
    const root = lines(
      sessionMeta("root-1"),
      turnContext("m"),
      r("root-1", "m", "a", { input: 10, output: 1 }),
      tokenCount({ input: 10, output: 1 }, { input: 10, output: 1 }, CODEX_LIMITS(20)),
      tokenCount(null, null, { limitId: "premium", primary: { usedPercent: 3, windowMinutes: 300, resetsAt: 1_900_000_100 } }),
    );
    const child = lines(sessionMeta("child-1", "root-1"), tokenCount(null, null, CODEX_LIMITS(25)), tokenCount(null, null, { primary: null }));
    const usage = parseRollouts([{ name: "a", content: root }, { name: "b", content: child }], undefined);
    expect(usage.rateLimits.map((snapshot) => [snapshot.limitId, snapshot.windows[0]?.usedPercent])).toEqual([
      ["codex", 25],
      ["premium", 3],
    ]);
    // A reading without a bucket id is skipped as a quota gap; the tokens stay clean.
    expect(usage.clean).toBe(true);
    expect(usage.gaps).toEqual(["b: line 3 has rate limits without a bucket id"]);
  });
});

describe("readRolloutFiles", () => {
  it("reads the rollouts under sessions/ at any depth, ignoring other files", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-rollouts-home-"));
    await mkdir(join(home, "sessions", "2026", "01", "02"), { recursive: true });
    await writeFile(join(home, "sessions", "2026", "01", "02", "rollout-b.jsonl"), "b\n");
    await writeFile(join(home, "sessions", "2026", "01", "02", "rollout-a.jsonl"), "a\n");
    await writeFile(join(home, "sessions", "2026", "01", "02", "notes.txt"), "x\n");
    const files = await readRolloutFiles(home);
    expect(files.map((file) => [file.name, file.content])).toEqual([
      [join("2026", "01", "02", "rollout-a.jsonl"), "a\n"],
      [join("2026", "01", "02", "rollout-b.jsonl"), "b\n"],
    ]);
  });

  it("returns nothing when Codex wrote no sessions directory", async () => {
    expect(await readRolloutFiles(await mkdtemp(join(tmpdir(), "codex-rollouts-empty-")))).toEqual([]);
  });
});
