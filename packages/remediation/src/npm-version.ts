/** Check support before relying on npm's package-specific release-age exclusions. */
import { isSemVer, versionScheme } from "../../ci/src/versions.ts";
import type { ProcessResult } from "../../ci/src/process.ts";

type NpmCommand = (dir: string, args: ReadonlyArray<string>) => Promise<ProcessResult>;

export async function requireNpmExcludes(npm: NpmCommand, dir: string, exclude: ReadonlyArray<string>, reason = "release-age exclusions"): Promise<void> {
  if (exclude.length === 0) {
    return;
  }
  const result = await npm(dir, ["--version"]);
  const version = result.stdout.trim();
  if (result.code !== 0 || !isSemVer(version) || versionScheme("npm").compare(version, "11.17.0") < 0) {
    const detected = result.stdout.trim() || result.stderr.trim() || "no version";
    throw new Error(`${reason} require npm >= 11.17.0 (min-release-age-exclude: ${exclude.join(", ")}); got ${detected}`);
  }
}
