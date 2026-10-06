import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { osvScannerVersion, scanWithOsvScanner } from "../src/osv-scanner.ts";
import type { PackageVersion } from "../src/package-version.ts";
import type { ProcessResult, RunProcess } from "../src/process.ts";
import { fromOsv } from "../src/take-snapshot.ts";

/** Real OSV-Scanner 2.6.0 output for the five packages below (recorded 2026-10-06). */
const FIXTURE = new URL("./fixtures/osv-scanner-2.6.0.json", import.meta.url);

const PACKAGES: PackageVersion[] = [
  { ecosystem: "npm", name: "source-map-js", version: "1.2.1" },
  { ecosystem: "npm", name: "source-map-js", version: "1.2.2" },
  { ecosystem: "npm", name: "flatmap-stream", version: "0.1.1" },
  { ecosystem: "Maven", name: "com.google.guava:guava", version: "31.0-jre" },
  { ecosystem: "Maven", name: "org.xerial.snappy:snappy-java", version: "1.1.10.8" },
];

interface Call {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly inventory: unknown;
  readonly config: string | undefined;
}

/** A fake binary: answers `scan` with `result` and records what it was asked. */
function scanner(result: Partial<ProcessResult> | (() => Promise<Partial<ProcessResult>>), calls: Call[] = []): RunProcess {
  return async (_command, args, options) => {
    const lockfile = args[args.indexOf("--lockfile") + 1]?.replace(/^osv-scanner:/, "");
    const configPath = args[args.indexOf("--config") + 1];
    calls.push({
      args,
      cwd: options?.cwd,
      inventory: lockfile === undefined ? undefined : JSON.parse(await readFile(lockfile, "utf8")),
      config: configPath === undefined ? undefined : await readFile(configPath, "utf8"),
    });
    const answer = typeof result === "function" ? await result() : result;
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
}

const fixture = async () => ({ code: 1, stdout: await readFile(FIXTURE, "utf8") });

describe("OSV-Scanner run", () => {
  it("reads every record of the real 2.6.0 output, malware included", async () => {
    const calls: Call[] = [];
    const found = await scanWithOsvScanner(PACKAGES, { binary: "osv-scanner", run: scanner(fixture, calls) });
    const ids = (key: string) => found.get(key)!.map((record) => record.id);
    expect(ids("npm|source-map-js|1.2.1")).toEqual(["GHSA-68fv-2mgg-jv7q"]);
    expect(ids("npm|source-map-js|1.2.2")).toEqual([]);
    expect(ids("Maven|org.xerial.snappy:snappy-java|1.1.10.8")).toEqual([]);
    expect(ids("Maven|com.google.guava:guava|31.0-jre")).toEqual(["GHSA-5mg8-w23w-74h3", "GHSA-7g45-4rm6-3mm3"]);
    expect(found.get("Maven|com.google.guava:guava|31.0-jre")![0]!.aliases).toContain("CVE-2020-8908");
    expect(found.get("npm|flatmap-stream|0.1.1")!.map((record) => [record.id, fromOsv(record).malicious])).toEqual([
      ["MAL-2025-20690", true],
      ["GHSA-9x64-5r7x-2q53", true],
      ["GHSA-mh6f-8j2x-4483", true],
    ]);
    expect(found.get("npm|source-map-js|1.2.1")![0]!.severity).toBe("HIGH");
  });

  it("asks once for the union, from an empty directory with an empty config", async () => {
    const calls: Call[] = [];
    await scanWithOsvScanner([...PACKAGES, PACKAGES[0]!], { binary: "osv-scanner", run: scanner(fixture, calls) });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.args.slice(0, 2)).toEqual(["scan", "source"]);
    expect(call!.args).toEqual(expect.arrayContaining(["--format", "json", "--all-packages", "--all-vulns", "--no-resolve"]));
    expect(call!.config).toBe("");
    expect(call!.cwd).toMatch(/supply-chain-osv-/);
    const listed = (call!.inventory as { results: Array<{ packages: Array<{ package: unknown }> }> }).results[0]!.packages;
    expect(listed).toHaveLength(PACKAGES.length);
    expect(listed[3]).toEqual({ package: { name: "com.google.guava:guava", version: "31.0-jre", ecosystem: "Maven" } });
  });

  it("runs nothing for nothing", async () => {
    const calls: Call[] = [];
    expect((await scanWithOsvScanner([], { binary: "osv-scanner", run: scanner({}, calls) })).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("fails closed on exit codes other than 0 and 1, output that doesn't parse, and missing packages", async () => {
    const run = (result: Partial<ProcessResult>) => scanWithOsvScanner(PACKAGES, { binary: "osv-scanner", run: scanner(result) });
    await expect(run({ code: 127, stderr: "boom\nnetwork unreachable" })).rejects.toThrow("exit code 127: network unreachable");
    await expect(run({ code: 0, stdout: "not json" })).rejects.toThrow("isn't JSON");
    await expect(run({ code: 0, stdout: "{}" })).rejects.toThrow("no `results` list");
    await expect(run({ code: 0, stdout: JSON.stringify({ results: [{}] }) })).rejects.toThrow("without a `packages` list");
    await expect(run({ code: 0, stdout: JSON.stringify({ results: [] }) })).rejects.toThrow(
      "didn't report on 5 requested package(s), e.g. source-map-js@1.2.1",
    );
    const odd = (vulnerabilities: unknown) =>
      JSON.stringify({ results: [{ packages: [{ package: { name: "x", version: "1.0.0", ecosystem: "npm" }, vulnerabilities }] }] });
    await expect(run({ code: 1, stdout: odd([{ id: "" }]) })).rejects.toThrow("without an id");
    await expect(run({ code: 1, stdout: odd([{ id: "GHSA-1", aliases: "CVE-1" }]) })).rejects.toThrow("`aliases` must be a list");
    await expect(run({ code: 1, stdout: odd([{ id: "GHSA-1", database_specific: { cwe_ids: "CWE-506" } }]) })).rejects.toThrow(
      "`cwe_ids` must be a list",
    );
    await expect(run({ code: 1, stdout: odd("GHSA-1") })).rejects.toThrow("malformed vulnerabilities");
    await expect(
      run({ code: 0, stdout: JSON.stringify({ results: [{ packages: [{ package: { name: "x", version: "1.0.0", ecosystem: "PyPI" } }] }] }) }),
    ).rejects.toThrow("malformed package");
  });

  it("leaves withdrawn records out", async () => {
    const stdout = JSON.stringify({
      results: [
        {
          packages: [
            {
              package: { name: "x", version: "1.0.0", ecosystem: "npm" },
              vulnerabilities: [{ id: "GHSA-gone", withdrawn: "2026-10-01T00:00:00Z" }, { id: "GHSA-live" }],
            },
          ],
        },
      ],
    });
    const found = await scanWithOsvScanner([{ ecosystem: "npm", name: "x", version: "1.0.0" }], {
      binary: "osv-scanner",
      run: scanner({ code: 1, stdout }),
    });
    expect(found.get("npm|x|1.0.0")!.map((record) => record.id)).toEqual(["GHSA-live"]);
  });

  it("checks the binary is a 2.x release", async () => {
    const version = (stdout: string, code = 0) => osvScannerVersion({ binary: "osv-scanner", run: async () => ({ code, stdout, stderr: "" }) });
    expect(await version("osv-scanner version: 2.6.0\nosv-scalibr version: 0.4.9\n")).toBe("2.6.0");
    await expect(version("osv-scanner version: 1.9.2\n")).rejects.toThrow("1.9.2 isn't supported");
    await expect(version("", 127)).rejects.toThrow("couldn't read the version");
  });
});
