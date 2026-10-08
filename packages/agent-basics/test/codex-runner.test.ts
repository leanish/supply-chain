// Copied from leanish/leanish-development core/runtime/test/unit/codex-runner.test.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CodexRunner } from "../src/skill/codex-runner.ts";
import { SkillLoader } from "../src/skill/skill-loader.ts";
import type { LoadedSkill } from "../src/skill/skill.ts";

const ASK_FILE = `---
name: ask
description: Test
inputSchema: { type: object }
outputSchema: { type: object }
---

# ask
`;

async function makeAskSkill(): Promise<LoadedSkill> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-codex-runner-skill-"));
  await mkdir(join(dir, "ask"), { recursive: true });
  await writeFile(join(dir, "ask", "SKILL.md"), ASK_FILE);
  return new SkillLoader({ skillsDirs: [dir] }).loadEntrypoint("ask");
}

/**
 * Stub `codex` binary that records its `CODEX_HOME` + argv into a file and
 * emits the canned response. We use the recorded file later to verify the
 * staging-dir + flags handshake. Its `app-server` (the runner's quota reading)
 * exits at once, unanswered.
 */
async function makeFakeBin(recordFile: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-fake-codex-"));
  const script = join(dir, "codex");
  await writeFile(
    script,
    `#!/bin/sh
[ "$1" = app-server ] && exit 1
{
  echo "CODEX_HOME=$CODEX_HOME"
  echo "ARGS=$*"
} > "${recordFile}"
cat <<'EOF'
\`\`\`json
{"answer": "codex fake answer"}
\`\`\`
EOF
`,
  );
  await chmod(script, 0o755);
  return script;
}

describe("CodexRunner (against a stub binary)", () => {
  let askSkill: LoadedSkill;
  beforeAll(async () => {
    askSkill = await makeAskSkill();
  });

  it("stages skills, sets CODEX_HOME, passes the suppression flags, captures stdout", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin });
    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "question: What does X do?",
      workingCopies: [],
    });
    expect(result.responseText).toContain('"answer": "codex fake answer"');

    const record = await readFile(recordFile, "utf8");
    // CODEX_HOME points at a temp dir the runner created.
    const codexHome = /CODEX_HOME=(.+)/.exec(record)?.[1] ?? "";
    expect(codexHome).toMatch(/agent-runtime-skill-/);
    // The canonical suppression flags appear in argv.
    expect(record).toMatch(
      /ARGS=exec --ignore-user-config -c project_doc_max_bytes=0 -c allow_login_shell=false -c features.shell_snapshot=false /,
    );
  });

  it("identifies itself as 'codex'", () => {
    const runner = new CodexRunner({ bin: "/nonexistent" });
    expect(runner.codingAgent).toBe("codex");
  });

  it("mounts the first working copy as cwd and the rest via --add-dir", async () => {
    const wc1 = await mkdtemp(join(tmpdir(), "codex-runner-wc1-"));
    const wc2 = await mkdtemp(join(tmpdir(), "codex-runner-wc2-"));
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin });
    await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [
        { projectId: "p1", path: wc1, branch: "main", headSha: "0".repeat(40) },
        { projectId: "p2", path: wc2, branch: "main", headSha: "0".repeat(40) },
      ],
    });
    const record = await readFile(recordFile, "utf8");
    expect(record).toContain(`--add-dir ${wc2}`);
  });

  it("wires `effort` through as `-c <effortConfigKey>=<value>` (default: model_reasoning_effort)", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin });
    await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      effort: "high",
    });
    const record = await readFile(recordFile, "utf8");
    expect(record).toContain("-c model_reasoning_effort=high");
  });

  it("honors a custom `effortConfigKey` (used to pin against the live CLI's key shape)", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin, effortConfigKey: "reasoning_effort" });
    await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      effort: "medium",
    });
    const record = await readFile(recordFile, "utf8");
    expect(record).toContain("-c reasoning_effort=medium");
    expect(record).not.toContain("model_reasoning_effort");
  });

  it("resolves a model family through `codex debug models` and reports the concrete model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-runtime-fake-codex-catalog-"));
    const recordFile = join(dir, "record.txt");
    const fakeBin = join(dir, "codex");
    await writeFile(
      fakeBin,
      `#!/bin/sh
echo "ARGS=$*" >> "${recordFile}"
if [ "$1" = "debug" ]; then
  echo '{"models":[{"slug":"gpt-6-luna","visibility":"list","supported_reasoning_levels":[{"effort":"xhigh"}]},{"slug":"gpt-5.6-luna","visibility":"list","supported_reasoning_levels":[]}]}'
  exit 0
fi
cat <<'EOF'
\`\`\`json
{"answer": "ok"}
\`\`\`
EOF
`,
    );
    await chmod(fakeBin, 0o755);
    const runner = new CodexRunner({ bin: fakeBin, suppressFlags: [] });

    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      model: "luna",
      effort: "xhigh",
    });

    const record = await readFile(recordFile, "utf8");
    expect(record).toContain("ARGS=debug models");
    expect(record).toContain("--model gpt-6-luna");
    expect(result.model).toBe("gpt-6-luna");
  });

  it("passes a concrete model id through without reading the catalog", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin });

    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      model: "gpt-6-sol",
    });

    const record = await readFile(recordFile, "utf8");
    expect(record).toContain("--model gpt-6-sol");
    expect(record).not.toContain("debug models");
    expect(result.model).toBeUndefined();
  });

  it("rejects an effort the resolved model doesn't support, before running the skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-runtime-fake-codex-effort-"));
    const fakeBin = join(dir, "codex");
    await writeFile(
      fakeBin,
      `#!/bin/sh
if [ "$1" = "debug" ]; then
  echo '{"models":[{"slug":"gpt-6.1-sol","visibility":"list","supported_reasoning_levels":[{"effort":"high"}]}]}'
  exit 0
fi
echo "exec must not run" >&2
exit 1
`,
    );
    await chmod(fakeBin, 0o755);
    const runner = new CodexRunner({ bin: fakeBin, suppressFlags: [] });

    await expect(
      runner.run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "x: 1",
        workingCopies: [],
        model: "sol",
        effort: "low",
      }),
    ).rejects.toThrowError(/effort 'low' is not supported by gpt-6.1-sol/);
  });

  it("runs the skill within what model discovery left of the timeout, not a fresh one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-runtime-fake-codex-budget-"));
    const fakeBin = join(dir, "codex");
    // Discovery takes 1s and the run 1.5s: each fits the 2s timeout alone, not together.
    await writeFile(
      fakeBin,
      `#!/bin/sh
[ "$1" = app-server ] && exit 1
if [ "$1" = "debug" ]; then
  sleep 1
  echo '{"models":[{"slug":"gpt-6-luna","visibility":"list","supported_reasoning_levels":[]}]}'
  exit 0
fi
sleep 1.5
echo '{"answer": "too late"}'
`,
    );
    await chmod(fakeBin, 0o755);
    const runner = new CodexRunner({ bin: fakeBin, suppressFlags: [], timeoutMs: 2000 });

    await expect(
      runner.run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "x: 1",
        workingCopies: [],
        model: "luna",
      }),
    ).rejects.toThrowError(/did not return within/);
  });

  it("fails without spawning codex when the timeout is already spent", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin, timeoutMs: 0 });

    await expect(
      runner.run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "x: 1",
        workingCopies: [],
      }),
    ).rejects.toThrowError(/invocation budget ran out/);
    await expect(readFile(recordFile, "utf8")).rejects.toThrowError(/ENOENT/);
  });

  it("propagates non-zero exit codes as errors with stderr tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-runtime-failing-codex-"));
    const failingBin = join(dir, "codex");
    await writeFile(failingBin, `#!/bin/sh\necho "codex boom" >&2\nexit 9\n`);
    await chmod(failingBin, 0o755);

    const runner = new CodexRunner({ bin: failingBin });
    await expect(
      runner.run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "x: 1",
        workingCopies: [],
      }),
    ).rejects.toThrowError(/exited with code 9.*codex boom/);
  });
});
