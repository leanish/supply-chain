import { describe, expect, it } from "vitest";

import type { PackageVersion } from "../src/package-version.ts";
import type { RunProcess } from "../src/process.ts";
import { MAVEN_CENTRAL } from "../src/source-repos.ts";
import { takeSnapshot } from "../src/take-snapshot.ts";
import { fakeFetch } from "./fake-fetch.ts";

const VITE: PackageVersion = { ecosystem: "npm", name: "vite", version: "8.3.1" };
const TAKEN = new Date("2026-10-06T20:00:00Z");

/** A fake osv-scanner that reports `vulnerabilities` for every requested package. */
function scanner(vulnerabilities: Record<string, Array<{ id: string; aliases?: string[] }>>): RunProcess {
  return async (_command, args) => {
    const lockfile = args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, "");
    const { readFile } = await import("node:fs/promises");
    const inventory = JSON.parse(await readFile(lockfile, "utf8")) as { results: Array<{ packages: Array<{ package: PackageVersion }> }> };
    const packages = inventory.results[0]!.packages.map(({ package: pkg }) => ({
      package: pkg,
      vulnerabilities: vulnerabilities[`${pkg.name}@${pkg.version}`] ?? [],
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
}

function repositoryAdvisory(ghsa: string, range: string, cweIds: string[] = []) {
  return {
    ghsa_id: ghsa,
    cve_id: null,
    state: "published",
    withdrawn_at: null,
    severity: "medium",
    cwe_ids: cweIds,
    vulnerabilities: [{ package: { ecosystem: "npm", name: "vite" }, vulnerable_version_range: range, patched_versions: "8.3.3" }],
  };
}

describe("advisory snapshot", () => {
  it("adds repository advisories OSV doesn't have, and lets OSV's verdict stand for those it has", async () => {
    const fetch = fakeFetch({
      "https://registry.npmjs.org/vite/8.3.1": { body: { repository: { url: "git+https://github.com/vitejs/vite.git" } } },
      "https://api.github.com/repos/vitejs/vite/security-advisories?state=published&per_page=100": {
        body: [repositoryAdvisory("GHSA-new-only-repo", ">=8.3.0,<=8.3.2"), repositoryAdvisory("GHSA-known-to-osv", ">=8.0.0")],
      },
      // OSV has the second one and lists vite, so OSV-Scanner's silence on 8.3.1 is the verdict.
      "https://api.osv.dev/v1/vulns/GHSA-known-to-osv": {
        body: { id: "GHSA-known-to-osv", modified: "2026-10-06T19:00:00Z", affected: [{ package: { ecosystem: "npm", name: "vite" } }] },
      },
    });
    const snapshot = await takeSnapshot([VITE], {
      osv: { binary: "osv-scanner", run: scanner({}) },
      sourceRepos: { fetch, overrides: new Map(), mavenRepositories: [MAVEN_CENTRAL] },
      repositoryAdvisories: { fetch, token: undefined },
      fetch,
      now: () => TAKEN,
    });
    expect(snapshot.advisories(VITE).map((advisory) => [advisory.id, advisory.source])).toEqual([["GHSA-new-only-repo", "repository"]]);
    expect(snapshot.takenAt).toEqual(TAKEN);
  });

  it("keeps a repository advisory when OSV's record doesn't name the package", async () => {
    const fetch = fakeFetch({
      "https://registry.npmjs.org/vite/8.3.1": { body: { repository: "github:vitejs/vite" } },
      "https://api.github.com/repos/vitejs/vite/security-advisories?state=published&per_page=100": {
        body: [repositoryAdvisory("GHSA-partly-known", ">=8.3.0,<=8.3.2")],
      },
      "https://api.osv.dev/v1/vulns/GHSA-partly-known": {
        body: { id: "GHSA-partly-known", modified: "2026-10-06T19:00:00Z", affected: [{ package: { ecosystem: "npm", name: "vite-plus" } }] },
      },
    });
    const snapshot = await takeSnapshot([VITE], {
      osv: { binary: "osv-scanner", run: scanner({ "vite@8.3.1": [{ id: "GHSA-from-osv", aliases: ["CVE-2026-5"] }] }) },
      sourceRepos: { fetch, overrides: new Map(), mavenRepositories: [MAVEN_CENTRAL] },
      repositoryAdvisories: { fetch, token: undefined },
      fetch,
      now: () => TAKEN,
    });
    expect(snapshot.advisories(VITE).map((advisory) => advisory.id)).toEqual(["GHSA-from-osv", "GHSA-partly-known"]);
    expect(snapshot.group("CVE-2026-5")).toBe("GHSA-from-osv");
  });

  it("keeps a repository advisory OSV only learned about after the scan started, and malware whatever OSV says", async () => {
    const osvRecord = (id: string, modified: string) => ({
      body: { id, modified, affected: [{ package: { ecosystem: "npm", name: "vite" } }] },
    });
    const fetch = fakeFetch({
      "https://registry.npmjs.org/vite/8.3.1": { body: { repository: "github:vitejs/vite" } },
      "https://api.github.com/repos/vitejs/vite/security-advisories?state=published&per_page=100": {
        body: [
          repositoryAdvisory("GHSA-imported-just-now", ">=8.0.0"),
          repositoryAdvisory("GHSA-malware-in-repo", ">=8.0.0", ["CWE-506"]),
        ],
      },
      // OSV-Scanner ran before this record existed (or changed), so its silence proves nothing.
      "https://api.osv.dev/v1/vulns/GHSA-imported-just-now": osvRecord("GHSA-imported-just-now", "2026-10-06T20:00:05Z"),
      // OSV has it from before, but doesn't call it malware: the repository's classification wins.
      "https://api.osv.dev/v1/vulns/GHSA-malware-in-repo": osvRecord("GHSA-malware-in-repo", "2026-10-01T00:00:00Z"),
    });
    const snapshot = await takeSnapshot([VITE], {
      osv: { binary: "osv-scanner", run: scanner({}) },
      sourceRepos: { fetch, overrides: new Map(), mavenRepositories: [MAVEN_CENTRAL] },
      repositoryAdvisories: { fetch, token: undefined },
      fetch,
      now: () => TAKEN,
    });
    expect(snapshot.advisories(VITE).map((advisory) => [advisory.id, advisory.malicious])).toEqual([
      ["GHSA-imported-just-now", false],
      ["GHSA-malware-in-repo", true],
    ]);
  });
});
