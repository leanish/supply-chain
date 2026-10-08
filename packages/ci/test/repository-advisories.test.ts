import { describe, expect, it } from "vitest";

import type { PackageVersion } from "../src/package-version.ts";
import { fetchRepositoryAdvisories, matchRepositoryAdvisories } from "../src/repository-advisories.ts";
import { githubRepository, MAVEN_CENTRAL, pomParent, pomRepository, sourceRepository } from "../src/source-repos.ts";
import { fakeFetch } from "./fake-fetch.ts";

const SNAPPY: PackageVersion = { ecosystem: "Maven", name: "org.xerial.snappy:snappy-java", version: "1.1.10.8" };
const API = "https://api.github.com/repos";

/** Shaped like `GET /repos/xerial/snappy-java/security-advisories` on 2026-10-06, trimmed. */
const SNAPPY_ADVISORIES = [
  {
    ghsa_id: "GHSA-wmgv-28fv-894x",
    cve_id: "CVE-2026-90559",
    state: "published",
    withdrawn_at: null,
    severity: "high",
    summary: "Out-of-bounds write",
    cwe_ids: ["CWE-787"],
    vulnerabilities: [
      {
        package: { ecosystem: "maven", name: "org.xerial.snappy:snappy-java" },
        vulnerable_version_range: "<= 1.1.10.8",
        patched_versions: "1.1.10.9",
      },
    ],
  },
  {
    ghsa_id: "GHSA-6gp7-6wmv-gxqw",
    cve_id: null,
    state: "published",
    withdrawn_at: null,
    severity: "high",
    summary: "Uncontrolled recursion",
    cwe_ids: ["CWE-674"],
    vulnerabilities: [
      { package: { ecosystem: "maven", name: "org.xerial.snappy:snappy-java" }, vulnerable_version_range: "<= 1.1.10.9" },
    ],
  },
  {
    // The 2023 advisory names the bare artifactId.
    ghsa_id: "GHSA-55g7-9cwv-5qfv",
    cve_id: "CVE-2023-43642",
    state: "published",
    withdrawn_at: null,
    severity: "high",
    summary: "Missing upper bound check",
    cwe_ids: ["CWE-770"],
    vulnerabilities: [{ package: { ecosystem: "maven", name: "snappy-java" }, vulnerable_version_range: "<= 1.1.10.3" }],
  },
  {
    ghsa_id: "GHSA-gone-gone-gone",
    cve_id: null,
    state: "published",
    withdrawn_at: "2026-10-04T00:00:00Z",
    severity: "low",
    cwe_ids: [],
    vulnerabilities: [{ package: { ecosystem: "maven", name: "org.xerial.snappy:snappy-java" }, vulnerable_version_range: "<= 9" }],
  },
];

const POM = `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.xerial.snappy</groupId>
  <artifactId>snappy-java</artifactId>
  <url>https://github.com/xerial/snappy-java</url>
  <licenses><license><url>https://www.apache.org/licenses/LICENSE-2.0.html</url></license></licenses>
  <scm>
    <url>https://github.com/xerial/snappy-java</url>
    <connection>scm:git@github.com:xerial/snappy-java.git</connection>
  </scm>
</project>`;

const sourceOptions = (routes: Parameters<typeof fakeFetch>[0]) => ({
  fetch: fakeFetch(routes),
  overrides: new Map<string, string>(),
  mavenRepositories: [MAVEN_CENTRAL],
});

describe("source repositories", () => {
  it("reads GitHub repositories from every spelling npm manifests and POMs use", () => {
    expect(githubRepository({ type: "git", url: "git+https://github.com/7rulnik/source-map-js.git" })).toBe("7rulnik/source-map-js");
    expect(githubRepository("git+ssh://git@github.com/Acme/Lib.git#main")).toBe("acme/lib");
    expect(githubRepository("scm:git:git@github.com:FasterXML/jackson-databind.git")).toBe("fasterxml/jackson-databind");
    expect(githubRepository("https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-s3")).toBe("aws/aws-sdk-js-v3");
    expect(githubRepository("github:acme/lib")).toBe("acme/lib");
    expect(githubRepository("acme/lib")).toBe("acme/lib");
    expect(githubRepository("https://gitlab.com/acme/lib")).toBeUndefined();
    expect(githubRepository(undefined)).toBeUndefined();
  });

  it("takes the POM's scm before its project url, ignoring urls of other sections", () => {
    expect(pomRepository(POM, SNAPPY)).toBe("xerial/snappy-java");
    const licenseOnly = `<project><licenses><license><url>https://github.com/not/this</url></license></licenses></project>`;
    expect(pomRepository(licenseOnly, SNAPPY)).toBeUndefined();
    const projectUrl = `<project><url>https://github.com/acme/\${project.artifactId}</url></project>`;
    expect(pomRepository(projectUrl, SNAPPY)).toBe("acme/snappy-java");
    const property = `<project><properties><repo>acme/tool</repo></properties><scm><url>https://github.com/\${repo}</url></scm></project>`;
    expect(pomRepository(property, SNAPPY)).toBe("acme/tool");
    expect(pomRepository(`<project><!-- <scm><url>https://github.com/old/one</url></scm> --></project>`, SNAPPY)).toBeUndefined();
  });

  it("walks up to the parent POM when a POM names no repository", async () => {
    const child: PackageVersion = { ecosystem: "Maven", name: "com.acme:child", version: "1.0.0" };
    const childPom = `<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>3</version></parent></project>`;
    expect(pomParent(childPom)).toEqual({ ecosystem: "Maven", name: "com.acme:parent", version: "3" });
    const options = sourceOptions({
      [`${MAVEN_CENTRAL}/com/acme/child/1.0.0/child-1.0.0.pom`]: { text: childPom },
      [`${MAVEN_CENTRAL}/com/acme/parent/3/parent-3.pom`]: { text: `<project><scm><url>https://github.com/acme/all</url></scm></project>` },
    });
    expect(await sourceRepository(child, options)).toBe("acme/all");
  });

  it("reads npm manifests, honors overrides, and fails closed on registry errors", async () => {
    const lib: PackageVersion = { ecosystem: "npm", name: "@scope/lib", version: "1.0.0" };
    const url = "https://registry.npmjs.org/@scope%2Flib/1.0.0";
    expect(await sourceRepository(lib, sourceOptions({ [url]: { body: { repository: "github:acme/lib" } } }))).toBe("acme/lib");
    expect(await sourceRepository(lib, sourceOptions({ [url]: { body: {} } }))).toBeUndefined();
    await expect(sourceRepository(lib, sourceOptions({ [url]: { status: 503 } }))).rejects.toThrow("HTTP 503");
    const overridden = { ...sourceOptions({}), overrides: new Map([["npm|@scope/lib", "Acme/Real"]]) };
    expect(await sourceRepository(lib, overridden)).toBe("acme/real");
  });
});

describe("repository advisories", () => {
  it("matches published advisories by full name or bare artifactId, skipping withdrawn ones", async () => {
    const fetch = fakeFetch({ [`${API}/xerial/snappy-java/security-advisories?state=published&per_page=100`]: { body: SNAPPY_ADVISORIES } });
    const old: PackageVersion = { ...SNAPPY, version: "1.1.10.3" };
    const fixed: PackageVersion = { ...SNAPPY, version: "1.1.10.10" };
    const repos = new Map([SNAPPY, old, fixed].map((pkg) => [`Maven|${pkg.name}|${pkg.version}`, "xerial/snappy-java"]));
    const match = await matchRepositoryAdvisories([SNAPPY, old, fixed], repos, { fetch, token: "t" });
    const ids = (pkg: PackageVersion) => match.affecting.get(`Maven|${pkg.name}|${pkg.version}`)!.map((advisory) => advisory.ghsaId);
    expect(ids(SNAPPY)).toEqual(["GHSA-wmgv-28fv-894x", "GHSA-6gp7-6wmv-gxqw"]);
    expect(ids(old)).toEqual(["GHSA-wmgv-28fv-894x", "GHSA-6gp7-6wmv-gxqw", "GHSA-55g7-9cwv-5qfv"]);
    expect(ids(fixed)).toEqual([]);
    expect(match.gaps).toEqual([]);
  });

  it("stops a range without an upper bound at its patched version", async () => {
    // vitest-dev/vitest's GHSA-82fw-gwwq-j7x9, verbatim: the 5.x entry has no upper bound but names its fix.
    const vitest = {
      ghsa_id: "GHSA-82fw-gwwq-j7x9",
      cve_id: null,
      state: "published",
      withdrawn_at: null,
      severity: "medium",
      cwe_ids: ["CWE-22"],
      vulnerabilities: [
        { package: { ecosystem: "npm", name: "vitest" }, vulnerable_version_range: ">=v2.1.0, <4.1.11", patched_versions: "4.1.11" },
        { package: { ecosystem: "npm", name: "vitest" }, vulnerable_version_range: ">=5.0.0-beta.1", patched_versions: "5.0.0-rc.2" },
        { package: { ecosystem: "npm", name: "other" }, vulnerable_version_range: ">=1.0.0", patched_versions: "" },
      ],
    };
    const fetch = fakeFetch({ [`${API}/vitest-dev/vitest/security-advisories?state=published&per_page=100`]: { body: [vitest] } });
    const versions = ["5.0.2", "5.0.0-beta.3", "4.1.10", "4.1.11"].map((version): PackageVersion => ({ ecosystem: "npm", name: "vitest", version }));
    const other: PackageVersion = { ecosystem: "npm", name: "other", version: "9.0.0" };
    const repos = new Map([...versions, other].map((pkg) => [`npm|${pkg.name}|${pkg.version}`, "vitest-dev/vitest"]));
    const match = await matchRepositoryAdvisories([...versions, other], repos, { fetch, token: undefined });
    const hit = (pkg: PackageVersion) => match.affecting.get(`npm|${pkg.name}|${pkg.version}`)!.length > 0;
    expect(versions.map(hit)).toEqual([false, true, true, false]);
    // No patched version named: the open range stands.
    expect(hit(other)).toBe(true);
  });

  it("reports packages without a repository, unreadable repositories and unreadable ranges as gaps", async () => {
    const odd = [{ ...SNAPPY_ADVISORIES[0], vulnerabilities: [{ package: { ecosystem: "maven", name: "snappy-java" }, vulnerable_version_range: "~> 1.1" }] }];
    const fetch = fakeFetch({ [`${API}/xerial/snappy-java/security-advisories?state=published&per_page=100`]: { body: odd } });
    const none: PackageVersion = { ecosystem: "npm", name: "orphan", version: "1.0.0" };
    const gone: PackageVersion = { ecosystem: "npm", name: "moved", version: "1.0.0" };
    const repos = new Map([
      ["Maven|org.xerial.snappy:snappy-java|1.1.10.8", "xerial/snappy-java"],
      ["npm|orphan|1.0.0", undefined],
      ["npm|moved|1.0.0", "acme/moved"],
    ]);
    const match = await matchRepositoryAdvisories([SNAPPY, none, gone], repos, { fetch, token: undefined });
    expect(match.gaps).toEqual([
      "GHSA-wmgv-28fv-894x (xerial/snappy-java) has a range the gate can't read for org.xerial.snappy:snappy-java@1.1.10.8",
      "npm orphan@1.0.0: no GitHub source repository found, so its repository advisories aren't read",
      "npm moved@1.0.0: source repository acme/moved isn't readable (renamed, deleted or private)",
    ]);
  });

  it("follows pagination, sends the token, and fails closed on API errors", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const first = `${API}/acme/lib/security-advisories?state=published&per_page=100`;
    const second = `${API}/acme/lib/security-advisories?state=published&per_page=100&page=2`;
    const fetch = fakeFetch(
      {
        [first]: { body: [SNAPPY_ADVISORIES[0]], headers: { link: `<${second}>; rel="next", <${second}>; rel="last"` } },
        [second]: { body: [SNAPPY_ADVISORIES[1]] },
      },
      requests,
    );
    const advisories = await fetchRepositoryAdvisories("acme/lib", { fetch, token: "secret" });
    expect(advisories!.map((advisory) => advisory.ghsaId)).toEqual(["GHSA-wmgv-28fv-894x", "GHSA-6gp7-6wmv-gxqw"]);
    expect(requests.map((request) => request.url)).toEqual([first, second]);
    expect(requests[0]!.headers["authorization"]).toBe("Bearer secret");

    const limited = fakeFetch({ [first]: { status: 403, body: {} } });
    await expect(fetchRepositoryAdvisories("acme/lib", { fetch: limited, token: undefined })).rejects.toThrow("HTTP 403 (rate limited? set GITHUB_TOKEN)");
    const malformed = fakeFetch({ [first]: { body: { message: "nope" } } });
    await expect(fetchRepositoryAdvisories("acme/lib", { fetch: malformed, token: undefined })).rejects.toThrow("aren't a list");
    const noId = fakeFetch({ [first]: { body: [{ state: "published" }] } });
    await expect(fetchRepositoryAdvisories("acme/lib", { fetch: noId, token: undefined })).rejects.toThrow("has no ghsa_id");
  });
});
