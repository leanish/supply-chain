import { describe, expect, it } from "vitest";

import { defaultConfigPath, parseToolConfig, repoOf } from "../src/config.ts";

const HOME = "/Users/dev";
const VALID = `
repos:
  - repo: leanish/sqs-codec
  - repo: leanish/dtv
    branch: main
agent: { codingAgent: codex, model: sol, effort: medium, majorEffort: high }
secrets: { write: leanish-secure-it-github, read: leanish-secure-it-github-read }
commitIdentity: { name: leanish, email: 5417585+leanish@users.noreply.github.com }
readDeny: [~/dev/private, /Volumes/vault]
`;

describe("tool config", () => {
  it.each(["secure-it", "bump-it"] as const)("defaults %s's Keychain services, allowing either or both to be overridden", (tool) => {
    const withoutSecrets = VALID.replace(/^secrets:.*\n/m, "");
    const defaults = { write: `leanish-${tool}-write`, read: `leanish-${tool}-read` };
    const secretsOf = (text: string) => parseToolConfig(tool, text, "agent.yaml", HOME).secrets;

    expect(secretsOf(withoutSecrets)).toEqual(defaults);
    expect(secretsOf(`${withoutSecrets}secrets: {}\n`)).toEqual(defaults);
    expect(secretsOf(`${withoutSecrets}secrets: { write: shared-write }\n`)).toEqual({ ...defaults, write: "shared-write" });
    expect(secretsOf(`${withoutSecrets}secrets: { read: shared-read }\n`)).toEqual({ ...defaults, read: "shared-read" });
    expect(secretsOf(`${withoutSecrets}secrets: { write: shared-write, read: shared-read }\n`)).toEqual({ write: "shared-write", read: "shared-read" });
    expect(() => secretsOf(`${withoutSecrets}secrets: { write: ${defaults.read} }\n`)).toThrow("must be different items");
  });

  it.each([
    ["null", "secrets must be a mapping"],
    ["[]", "secrets must be a mapping"],
    ["shared-write", "secrets must be a mapping"],
    ["{ reads: shared-read }", "unknown field(s): reads"],
    ['{ write: "" }', "secrets.write must be a non-empty string"],
    ["{ read: null }", "secrets.read must be a non-empty string"],
    ["{ write: 12 }", "secrets.write must be a non-empty string"],
  ])("rejects invalid secret overrides: %s", (secrets, message) => {
    expect(() => parseToolConfig("secure-it", VALID.replace(/^secrets:.*$/m, `secrets: ${secrets}`), "agent.yaml", HOME)).toThrow(message);
  });

  it("rejects repository-specific secrets", () => {
    const text = VALID.replace("- repo: leanish/sqs-codec", "- repo: leanish/sqs-codec\n    secrets: { write: repo-write, read: repo-read }");
    expect(() => parseToolConfig("secure-it", text, "agent.yaml", HOME)).toThrow("unknown field(s): secrets");
  });

  it("reads the repos, agent, secrets and identity, with defaults under the home and ~ expanded", () => {
    const config = parseToolConfig("secure-it", VALID, "agent.yaml", HOME);
    expect(config).toEqual({
      tool: "secure-it",
      repos: [
        { repo: "leanish/sqs-codec", branch: undefined },
        { repo: "leanish/dtv", branch: "main" },
      ],
      agent: { codingAgent: "codex", model: "sol", effort: "medium", majorEffort: "high" },
      secrets: { write: "leanish-secure-it-github", read: "leanish-secure-it-github-read" },
      commitIdentity: { name: "leanish", email: "5417585+leanish@users.noreply.github.com" },
      dirs: { state: "/Users/dev/.local/share/leanish/secure-it", cache: "/Users/dev/.cache/leanish/secure-it" },
      readDeny: ["/Users/dev/dev/private", "/Volumes/vault"],
      modelPrices: undefined,
      staleScanHours: 36,
      maxNewMajorsPerRun: undefined,
    });
    expect(defaultConfigPath("bump-it", HOME)).toBe("/Users/dev/.config/leanish/bump-it/agent.yaml");
    expect(repoOf(config, "Leanish/SQS-codec").repo).toBe("leanish/sqs-codec");
    expect(() => repoOf(config, "leanish/java-conventions")).toThrow("opts in explicitly");
  });

  it("fails on what would quietly change behaviour", () => {
    const failing: Array<[string, string]> = [
      [VALID.replace("readDeny:", "readDenny:"), "unknown field(s): readDenny"],
      [VALID.replace("leanish/sqs-codec", "../sqs-codec"), "repository id '../sqs-codec' isn't owner/slug"],
      [VALID.replace("leanish/dtv", "leanish/sqs-codec"), "lists leanish/sqs-codec twice"],
      [VALID.replace("codingAgent: codex", "codingAgent: claude-code"), "must be codex"],
      [VALID.replace("read: leanish-secure-it-github-read", "read: leanish-secure-it-github"), "must be different items"],
      [VALID.replace("[~/dev/private, /Volumes/vault]", "[dev/private]"), "readDeny[0] must be an absolute path"],
      [`${VALID}staleScanHours: 0\n`, "staleScanHours must be a positive integer"],
      [VALID.replace(/repos:[\s\S]*?agent:/, "repos: []\nagent:"), "lists no repository"],
      ["repos: [", "isn't YAML"],
    ];
    for (const [text, message] of failing) expect(() => parseToolConfig("secure-it", text, "agent.yaml", HOME)).toThrow(message);
    expect(() => parseToolConfig("bump-it", `${VALID}staleScanHours: 24\n`, "agent.yaml", HOME)).toThrow("staleScanHours is secure-it's");
    expect(parseToolConfig("bump-it", VALID, "agent.yaml", HOME).staleScanHours).toBeUndefined();
    expect(() => parseToolConfig("secure-it", `${VALID}maxNewMajorsPerRun: 2\n`, "agent.yaml", HOME)).toThrow("maxNewMajorsPerRun is bump-it's");
    expect(() => parseToolConfig("bump-it", `${VALID}maxNewMajorsPerRun: -1\n`, "agent.yaml", HOME)).toThrow("non-negative integer");
    expect(parseToolConfig("bump-it", VALID, "agent.yaml", HOME).maxNewMajorsPerRun).toBe(3);
    expect(parseToolConfig("bump-it", `${VALID}maxNewMajorsPerRun: 0\n`, "agent.yaml", HOME).maxNewMajorsPerRun).toBe(0);
  });
});
