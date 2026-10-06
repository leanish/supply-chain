// New in this repository: the secret store the plan asks for (macOS Keychain first; Linux Secret Service, Windows
// Credential Manager or environment variables are later implementations of the same interface).
import { execFile } from "node:child_process";

export interface SecretStore {
  /** The secret stored under `name`; throws when it's missing or empty. The value is never logged. */
  get(name: string): Promise<string>;
}

/** What `KeychainStore` runs; defaults to the real `security` binary. */
export type RunSecurity = (args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string }>;

/**
 * macOS Keychain generic passwords, looked up by service name
 * (`security find-generic-password -s <name> -w`). Only the tool's own
 * process reads them; the agent gets what the tool hands it in env.
 */
export class KeychainStore implements SecretStore {
  readonly #run: RunSecurity;

  constructor(run: RunSecurity = runSecurity) {
    this.#run = run;
  }

  async get(name: string): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Keychain service names are letters, digits, '.', '_' and '-'; got '${name}'`);
    const result = await this.#run(["find-generic-password", "-s", name, "-w"]);
    // Never the output: on success it's the secret, on failure `security` says nothing useful about it.
    if (result.code !== 0) throw new Error(`no Keychain item for service '${name}' (security exited ${result.code})`);
    const value = result.stdout.replace(/\n$/, "");
    if (value === "") throw new Error(`the Keychain item for service '${name}' is empty`);
    return value;
  }
}

function runSecurity(args: ReadonlyArray<string>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("security", [...args], { encoding: "utf8" }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout });
    });
  });
}
