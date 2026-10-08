import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Runs a command without a shell and collects its output; never rejects on a nonzero exit. */
export type RunProcess = (command: string, args: ReadonlyArray<string>, options?: ProcessOptions) => Promise<ProcessResult>;

export const runProcess: RunProcess = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => reject(new Error(`couldn't run ${command}: ${err.message}`)));
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });

/** Credentials no tool the gate runs needs, kept out of its environment (a PR's `.npmrc` can expand variables). */
const CREDENTIALS = ["GITHUB_TOKEN", "GH_TOKEN", "GIT_FETCH_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"];

export function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !CREDENTIALS.includes(key)));
}
