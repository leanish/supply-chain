import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseToolConfig, repoOf } from "../src/config.ts";

const EXAMPLES = new URL("../../../docs/examples/", import.meta.url);
const HOME = "/Users/YOUR_USER";
const TOOLS = ["secure-it", "bump-it"] as const;

describe("documented agent configs", () => {
  it.each(TOOLS)("%s's complete example opts in the scheduled repo with default Keychain services and separate directories", async (tool) => {
    const file = new URL(`${tool}-agent.yaml`, EXAMPLES);
    const config = parseToolConfig(tool, await readFile(file, "utf8"), fileURLToPath(file), HOME);

    expect(repoOf(config, "acme/widget").branch).toBe("main");
    expect(config.agent).toEqual({ codingAgent: "codex", model: "sol", effort: "medium", majorEffort: "high" });
    expect(config.secrets).toEqual({ write: `leanish-${tool}-write`, read: `leanish-${tool}-read` });
    expect(config.dirs).toEqual({ state: `${HOME}/.local/share/leanish/${tool}`, cache: `${HOME}/.cache/leanish/${tool}` });
    expect(config.readDeny).toEqual([]);
    expect(config.staleScanHours).toBe(tool === "secure-it" ? 36 : undefined);
    expect(config.maxNewMajorsPerRun).toBe(tool === "bump-it" ? 3 : undefined);
  });
});

interface LaunchAgent {
  readonly Label: string;
  readonly ProgramArguments: ReadonlyArray<string>;
  readonly WorkingDirectory: string;
  readonly EnvironmentVariables: Readonly<Record<string, string>>;
  readonly StartInterval?: number;
  readonly StartCalendarInterval?: Readonly<Record<string, number>>;
  readonly StandardOutPath: string;
  readonly StandardErrorPath: string;
  readonly RunAtLoad?: boolean;
  readonly KeepAlive?: boolean;
}

describe.skipIf(process.platform !== "darwin")("documented launchd schedules", () => {
  for (const tool of TOOLS) {
    it.each(["run", "review"] as const)(`${tool} %s uses the real launcher with absolute paths and no credentials`, (command) => {
      const label = `leanish.${tool}.widget.${command}`;
      const file = fileURLToPath(new URL(`${label}.plist`, EXAMPLES));
      const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" })) as LaunchAgent;

      expect(plist.Label).toBe(label);
      expect(plist.ProgramArguments).toEqual([
        `${HOME}/dev/supply-chain/packages/remediation/run.sh`, tool, command, "acme/widget",
        "--config", `${HOME}/.config/leanish/${tool}/agent.yaml`,
      ]);
      expect(plist.WorkingDirectory).toBe(`${HOME}/dev/supply-chain`);
      expect(Object.keys(plist.EnvironmentVariables).sort()).toEqual(["HOME", "PATH"]);
      expect(plist.EnvironmentVariables["HOME"]).toBe(HOME);
      expect(plist.StandardOutPath).toBe(`${HOME}/Library/Logs/leanish/${tool}.widget.${command}.out.log`);
      expect(plist.StandardErrorPath).toBe(`${HOME}/Library/Logs/leanish/${tool}.widget.${command}.err.log`);
      expect(plist.RunAtLoad).toBeUndefined();
      expect(plist.KeepAlive).toBeUndefined();
      expect(plist.StartInterval).toBe(command === "review" ? 14400 : undefined);
      expect(plist.StartCalendarInterval).toEqual(command === "review" ? undefined :
        tool === "secure-it" ? { Hour: 7, Minute: 17 } : { Weekday: 1, Hour: 8, Minute: 23 });
    });
  }
});
