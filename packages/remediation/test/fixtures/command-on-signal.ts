// A tool command whose run waits to be killed, with fakes for everything outside: argv[2] is run.sh's marker file.
import { InMemoryWorkspace } from "../../../agent-basics/src/working-copy/in-memory-workspace.ts";
import { FakeCodingAgentRunner } from "../../../agent-basics/src/skill/fake-runner.ts";
import { runToolCommand } from "../../src/command.ts";

const CONFIG = `
repos: [{ repo: leanish/widget, branch: main }]
agent: { codingAgent: codex, model: sol, effort: medium, majorEffort: high }
secrets: { write: w, read: r }
commitIdentity: { name: leanish, email: leanish@example.com }
dirs: { state: /tmp/tool-state, cache: /tmp/tool-cache }
`;

process.exitCode = await runToolCommand(
  {
    tool: "secure-it",
    skills: { dirs: ["/nonexistent"], entrypoints: [], support: [] },
    run: async () => {
      process.stderr.write("waiting to be killed\n");
      await new Promise((settle) => setTimeout(settle, 30_000));
      return {};
    },
    review: async () => ({}),
  },
  ["run", "leanish/widget", "--config", "/config.yaml"],
  {
    secrets: { get: async (name) => `${name}-token` },
    readText: async () => CONFIG,
    workspace: () => new InMemoryWorkspace(),
    runner: () => new FakeCodingAgentRunner("codex"),
    reportMarker: process.argv[2],
  },
);
