// Copied from leanish/leanish-development core/runtime/test/unit/claude-code-runner.test.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { ClaudeCodeRunner } from "../src/skill/claude-code-runner.ts";
import { SkillLoader } from "../src/skill/skill-loader.ts";
import type { LoadedSkill } from "../src/skill/skill.ts";
import type { SkillUsage } from "../src/usage/skill-usage.ts";

const ASK_FILE = `---
name: ask
description: Test
inputSchema: { type: object }
outputSchema: { type: object }
---

# ask
`;

/** Stage a real on-disk skill so `fs.cp` has something to copy. */
async function makeAskSkill(): Promise<LoadedSkill> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-runner-skill-"));
  await mkdir(join(dir, "ask"), { recursive: true });
  await writeFile(join(dir, "ask", "SKILL.md"), ASK_FILE);
  return new SkillLoader({ skillsDirs: [dir] }).loadEntrypoint("ask");
}

/**
 * Use a fake `claude` binary that just emits a canned fenced-json
 * response. This exercises the orchestration (staging + spawn + capture)
 * without needing the real CLI installed.
 */
async function makeFakeBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-fake-claude-"));
  const script = join(dir, "claude");
  await writeFile(
    script,
    `#!/bin/sh
# Echo a fixed response — ignores all args. The runner just needs stdout.
cat <<'EOF'
<thinking>fake claude</thinking>

\`\`\`json
{"answer": "fake answer"}
\`\`\`
EOF
`,
  );
  await chmod(script, 0o755);
  return script;
}

/**
 * Fake `claude` binary that records its argv + cwd into a file so we can
 * assert on flag wiring (e.g. `--add-dir`).
 */
async function makeRecordingBin(recordFile: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-recording-claude-"));
  const script = join(dir, "claude");
  await writeFile(
    script,
    `#!/bin/sh
{
  echo "CWD=$(pwd)"
  echo "ARGS=$*"
} > "${recordFile}"
cat <<'EOF'
\`\`\`json
{"answer": "ok"}
\`\`\`
EOF
`,
  );
  await chmod(script, 0o755);
  return script;
}

describe("ClaudeCodeRunner (against a stub binary)", () => {
  let fakeBin: string;
  let askSkill: LoadedSkill;

  beforeAll(async () => {
    fakeBin = await makeFakeBin();
    askSkill = await makeAskSkill();
  });

  it("stages skills, spawns the binary, and returns the response text", async () => {
    const runner = new ClaudeCodeRunner({ bin: fakeBin });
    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "question: What does X do?",
      workingCopies: [],
    });
    expect(result.responseText).toContain('"answer": "fake answer"');
  });

  it("mounts the first working copy as cwd and the rest via --add-dir", async () => {
    const wc1 = await mkdtemp(join(tmpdir(), "claude-runner-wc1-"));
    const wc2 = await mkdtemp(join(tmpdir(), "claude-runner-wc2-"));
    const wc3 = await mkdtemp(join(tmpdir(), "claude-runner-wc3-"));
    const recordFile = join(await mkdtemp(join(tmpdir(), "claude-record-")), "record.txt");
    const recBin = await makeRecordingBin(recordFile);
    const runner = new ClaudeCodeRunner({ bin: recBin });
    await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [
        { projectId: "p1", path: wc1, branch: "main", headSha: "0".repeat(40) },
        { projectId: "p2", path: wc2, branch: "main", headSha: "0".repeat(40) },
        { projectId: "p3", path: wc3, branch: "main", headSha: "0".repeat(40) },
      ],
    });
    const record = await readFile(recordFile, "utf8");
    // realpath canonicalisation may resolve symlinks on macOS — match the basename.
    expect(record).toMatch(new RegExp(`CWD=.*${wc1.replace(/^.*\//, "")}`));
    expect(record).toContain(`--add-dir ${wc2}`);
    expect(record).toContain(`--add-dir ${wc3}`);
  });

  it("merges per-invocation env over the runner's configured base", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-env-"));
    const envBin = join(dir, "claude");
    await writeFile(
      envBin,
      `#!/bin/sh
cat <<EOF
BASE=[$BASE_VAR] OVERLAP=[$OVERLAP_VAR] CRED=[$CRED_VAR]
\\\`\\\`\\\`json
{"answer": "ok"}
\\\`\\\`\\\`
EOF
`,
    );
    await chmod(envBin, 0o755);
    const runner = new ClaudeCodeRunner({
      bin: envBin,
      env: { BASE_VAR: "from-runner", OVERLAP_VAR: "from-runner" },
    });
    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      env: { OVERLAP_VAR: "from-invocation", CRED_VAR: "tok" },
    });
    expect(result.responseText).toContain("BASE=[from-runner] OVERLAP=[from-invocation] CRED=[tok]");
  });

  it("passes --effort through to the CLI (verbatim for low/medium/high/xhigh)", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "claude-effort-")), "record.txt");
    const recBin = await makeRecordingBin(recordFile);
    const runner = new ClaudeCodeRunner({ bin: recBin });
    await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      effort: "high",
    });
    const record = await readFile(recordFile, "utf8");
    expect(record).toContain("--effort high");
  });

  it("maps the suite-level `minimal` effort to the CLI's `low` (CLI rejects `minimal`)", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "claude-effort-")), "record.txt");
    const recBin = await makeRecordingBin(recordFile);
    const runner = new ClaudeCodeRunner({ bin: recBin });
    await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      effort: "minimal",
    });
    const record = await readFile(recordFile, "utf8");
    expect(record).toContain("--effort low");
    expect(record).not.toContain("minimal");
  });

  it("refuses write access before staging anything", async () => {
    const stagingParentDir = await mkdtemp(join(tmpdir(), "claude-runner-staging-"));
    const runner = new ClaudeCodeRunner({ bin: fakeBin, stagingParentDir });
    await expect(
      runner.run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "x: 1",
        workingCopies: [],
        access: "write",
      }),
    ).rejects.toThrowError(/access 'write' isn't supported yet/);
    expect(await readdir(stagingParentDir)).toEqual([]);
  });

  it("propagates non-zero exit codes as errors with stderr tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-runtime-failing-claude-"));
    const failingBin = join(dir, "claude");
    await writeFile(failingBin, `#!/bin/sh\necho "boom" >&2\nexit 7\n`);
    await chmod(failingBin, 0o755);

    const runner = new ClaudeCodeRunner({ bin: failingBin });
    await expect(
      runner.run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "x: 1",
        workingCopies: [],
      }),
    ).rejects.toThrowError(/exited with code 7.*boom/);
  });

  it("reports the duration and requested model only: no tokens, cost or plan usage (a gap)", async () => {
    const usages: SkillUsage[] = [];
    await new ClaudeCodeRunner({ bin: fakeBin }).run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      model: "claude-model-x",
      onUsage: (usage) => usages.push(usage),
    });
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      codingAgent: "claude-code",
      requestedModel: "claude-model-x",
      synthetic: false,
      measurement: "partial",
      models: [],
      quota: { status: "unavailable" },
      gaps: [expect.stringMatching(/doesn't read Claude Code's token usage/)],
    });
    expect(usages[0]?.tokens).toBeUndefined();
    expect(usages[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports zero usage once when it refuses before spawning", async () => {
    const usages: SkillUsage[] = [];
    await expect(
      new ClaudeCodeRunner({ bin: fakeBin }).run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "x: 1",
        workingCopies: [],
        access: "write",
        onUsage: (usage) => usages.push(usage),
      }),
    ).rejects.toThrowError(/access 'write'/);
    expect(usages).toEqual([
      expect.objectContaining({ measurement: "complete", tokens: expect.objectContaining({ total: 0 }), quota: { status: "not-applicable", reason: "no provider call was made" } }),
    ]);
  });
});
