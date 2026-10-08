// run.sh's contract, adapted from leanish/leanish-development agents/bump-it/test/local-run.test.ts at e4f8a1e: the
// lock, the final-line handshake and the phases, with a fake tool command. macOS only (lockf).
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const RUN_SH = fileURLToPath(new URL("../run.sh", import.meta.url));

let dir: string;
let reporting: string;
let silent: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "run-sh-"));
  // A tool that confirms it reports, writes its own final line, and exits with its first argument's code.
  reporting = join(dir, "reporting.mjs");
  await writeFile(
    reporting,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.TOOL_REPORT_MARKER, "tool reports\\n");
process.stderr.write(JSON.stringify({ msg: "run finished", source: "tool", args: process.argv.slice(2) }) + "\\n");
process.exit(process.argv[2] === "review" ? 1 : 0);
`,
  );
  // A tool that dies before reporting.
  silent = join(dir, "silent.mjs");
  await writeFile(silent, `process.exit(3);\n`);
});

function run(args: ReadonlyArray<string>, cli: string) {
  const result = spawnSync("/bin/bash", [RUN_SH, ...args], { env: { ...process.env, TOOL_CLI: cli, XDG_STATE_HOME: dir }, encoding: "utf8" });
  const finals = result.stderr
    .split("\n")
    .filter((line) => line.includes('"run finished"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code: result.status, finals };
}

describe.skipIf(process.platform !== "darwin")("run.sh", () => {
  it("hands the final line to a tool that reports, passing its arguments and exit code through", () => {
    const ok = run(["secure-it", "run", "leanish/widget", "--config", "/x/agent.yaml"], reporting);
    expect(ok.code).toBe(0);
    expect(ok.finals).toEqual([{ msg: "run finished", source: "tool", args: ["run", "leanish/widget", "--config", "/x/agent.yaml"] }]);
    const failing = run(["secure-it", "review", "leanish/widget"], reporting);
    expect(failing.code).toBe(1);
    expect(failing.finals).toHaveLength(1);
  });

  it("writes the final line itself, with the phase, when it stops first or the tool dies before reporting", () => {
    expect(run(["secure-it", "fix", "leanish/widget"], reporting)).toEqual({
      code: 64,
      finals: [expect.objectContaining({ source: "run.sh", phase: "arguments", status: "error", exitCode: 64 })],
    });
    expect(run(["bump-it", "run", "../widget"], reporting).code).toBe(64);
    const missing = run(["bump-it", "run", "leanish/widget"], join(dir, "nope.mjs"));
    expect(missing).toEqual({ code: 78, finals: [expect.objectContaining({ phase: "tool-files", tool: "bump-it", repo: "leanish/widget" })] });
    const died = run(["secure-it", "run", "leanish/widget"], silent);
    expect(died).toEqual({ code: 3, finals: [expect.objectContaining({ phase: "tool-start", status: "error", exitCode: 3 })] });
  });

  it("refuses a second run of the same tool on the same repository while the first holds the lock", async () => {
    const lock = join(dir, "leanish", "secure-it", "locks", "leanish_widget.lock");
    spawnSync("/bin/mkdir", ["-p", join(dir, "leanish", "secure-it", "locks")]);
    const holder = spawn("lockf", ["-k", "-t", "0", lock, "/bin/sleep", "5"], { stdio: "ignore" });
    try {
      await new Promise((settle) => setTimeout(settle, 300));
      const refused = run(["secure-it", "run", "leanish/widget"], reporting);
      expect(refused).toEqual({ code: 75, finals: [expect.objectContaining({ phase: "lock", exitCode: 75 })] });
      // Another repository, or the other tool, isn't blocked.
      expect(run(["secure-it", "run", "leanish/other"], reporting).code).toBe(0);
      expect(run(["bump-it", "run", "leanish/widget"], reporting).code).toBe(0);
    } finally {
      holder.kill();
    }
  }, 20_000);
});
