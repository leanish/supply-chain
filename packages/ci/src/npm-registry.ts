/**
 * The npm registry: publish times, versions, and the publisher identity
 * checks (how stolen-token and hijacked publishes tend to look). Whatever its
 * age, a version that replaces another fails on an identity break against
 * the versions it replaces, unless an `identity` exception accepts it:
 *   - the replaced version had SLSA provenance and this one has none, or its
 *     provenance names another source repository or workflow;
 *   - the replaced version had none, and this one's provenance names another
 *     repository than the replaced version declares;
 *   - neither has provenance, and this one's publisher hadn't published any
 *     version up to the replaced one (later releases don't count as history).
 * A package the change adds has no such baseline. Every provenance statement
 * read must name the exact package, version and locked sha512.
 *
 * Ported from leanish-development `tools/supply-chain/src/supply-chain.ts`
 * (commit 9e7d098). Registry package names are now encoded as whole URL
 * components; empty and dot components fail before a request is made.
 */
import type { Exceptions } from "./exceptions.ts";
import type { Fetch } from "./http.ts";
import { dig, isObject } from "./json.ts";
import { type LockedPackage, NPM_REGISTRY } from "./npm-lock.ts";
import { npmPackageUrl } from "./npm-url.ts";

const ATTESTATIONS_URL = `${NPM_REGISTRY}/-/npm/v1/attestations/`;
const SLSA_PROVENANCE = "https://slsa.dev/provenance/";

/** A package's full registry document, reduced to what the gate reads. */
export interface Packument {
  readonly times: Record<string, unknown>;
  readonly versions: Record<string, unknown>;
}

/** Fetches each packument once per run. */
export class NpmRegistry {
  private readonly fetch: Fetch;
  private readonly packuments = new Map<string, Promise<Packument>>();
  private readonly statements = new Map<string, Promise<Statement>>();

  constructor(fetch: Fetch) {
    this.fetch = fetch;
  }

  packument(name: string): Promise<Packument> {
    let cached = this.packuments.get(name);
    if (cached === undefined) {
      cached = fetchPackument(name, this.fetch);
      this.packuments.set(name, cached);
    }
    return cached;
  }

  /** Publisher identity breaks of `pkg`, all accepted or none by one `identity` exception. */
  async identityProblems(
    pkg: LockedPackage,
    shipped: ReadonlyMap<string, string | undefined>,
    exceptions: Exceptions,
    today: string,
  ): Promise<string[]> {
    const doc = await this.packument(pkg.name);
    const label = `${pkg.name}@${pkg.version}`;
    const candidateUrl = provenanceUrl(doc, pkg.name, pkg.version);
    const candidate = candidateUrl === undefined ? undefined : await this.provenance(candidateUrl, pkg.name, pkg.version, pkg.integrity);
    // A replaced version the registry no longer lists (unpublished) can't serve as a baseline.
    const baseline = [...shipped.keys()].filter((version) => doc.versions[version] !== undefined);
    if (baseline.length === 0) return [];
    const breaks: string[] = [];
    const attested = baseline.flatMap((version) => {
      const url = provenanceUrl(doc, pkg.name, version);
      return url === undefined ? [] : [{ version, url }];
    });
    if (attested.length > 0) {
      for (const { version, url } of attested) {
        if (candidate === undefined) {
          breaks.push(`${label} has no provenance, but the version it replaces (${version}) had it`);
          continue;
        }
        const was = await this.provenance(url, pkg.name, version, shipped.get(version));
        if (was.source !== candidate.source) {
          breaks.push(`${label} was built from ${candidate.source}, but the version it replaces (${version}) from ${was.source}`);
        }
      }
    } else if (candidate !== undefined) {
      const declared = baseline.map((version) => githubRepository(manifestDist(doc, pkg.name, version).manifest["repository"]));
      if (candidate.repository === undefined || !declared.includes(candidate.repository)) {
        breaks.push(`${label} was built from ${candidate.source}, a repository the version it replaces (${baseline.join(", ")}) doesn't declare`);
      }
    } else {
      const publisher = publisherOf(doc, pkg.name, pkg.version);
      if (publisher === undefined) throw new Error(`registry names no publisher for ${label}`);
      const cutoff = Math.max(...baseline.map((version) => publishTime(doc, pkg.name, version).getTime()));
      const history = Object.keys(doc.versions).filter((version) => publishTime(doc, pkg.name, version).getTime() <= cutoff);
      if (!history.some((version) => publisherOf(doc, pkg.name, version) === publisher)) {
        breaks.push(`${label} has no provenance and its publisher ${publisher} hadn't published any version up to the one it replaces`);
      }
    }
    if (breaks.length === 0) return [];
    const exception = exceptions.identity.find((entry) => entry.package === pkg.name && entry.version === pkg.version);
    if (exception === undefined) return breaks;
    if (exception.expires < today) return [`${label}: its identity exception expired on ${exception.expires}`];
    return [];
  }

  /**
   * The provenance at `url`, after checking that its statement describes
   * exactly `name@version` with the locked sha512. Each URL is fetched once.
   */
  private async provenance(url: string, name: string, version: string, integrity: string | undefined): Promise<Provenance> {
    let cached = this.statements.get(url);
    if (cached === undefined) {
      cached = fetchStatement(url, this.fetch);
      this.statements.set(url, cached);
    }
    const statement = await cached;
    const digest = sha512Hex(integrity);
    if (digest === undefined) throw new Error(`no locked sha512 to bind ${name}@${version}'s provenance to`);
    if (statement.subject !== `pkg:npm/${name.replace(/^@/, "%40")}@${version}` || statement.sha512 !== digest) {
      throw new Error(`provenance at ${url} doesn't describe ${name}@${version} as locked`);
    }
    return statement.source;
  }
}

async function fetchPackument(name: string, fetch: Fetch): Promise<Packument> {
  const response = await fetch(npmPackageUrl(name), { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`registry lookup of ${name} failed with HTTP ${response.status}`);
  const json = await response.json();
  const times = isObject(json) ? json["time"] : undefined;
  const versions = isObject(json) ? json["versions"] : undefined;
  if (!isObject(times) || !isObject(versions)) throw new Error(`registry entry of ${name} is malformed`);
  return { times, versions };
}

function manifestDist(doc: Packument, name: string, version: string): { manifest: Record<string, unknown>; dist: Record<string, unknown> } {
  const manifest = doc.versions[version];
  const dist = isObject(manifest) ? manifest["dist"] : undefined;
  if (!isObject(manifest) || !isObject(dist)) throw new Error(`registry has no valid manifest for ${name}@${version}`);
  return { manifest, dist };
}

/**
 * The registry URL of `name@version`'s SLSA provenance attestation, or
 * undefined when it has none (a publish attestation alone isn't provenance).
 */
function provenanceUrl(doc: Packument, name: string, version: string): string | undefined {
  const attestations = manifestDist(doc, name, version).dist["attestations"];
  if (attestations === undefined) return undefined;
  const provenance = isObject(attestations) ? attestations["provenance"] : undefined;
  if (isObject(attestations) && provenance === undefined) return undefined;
  const url = isObject(attestations) ? attestations["url"] : undefined;
  const predicateType = isObject(provenance) ? provenance["predicateType"] : undefined;
  if (
    typeof predicateType !== "string" ||
    !predicateType.startsWith(SLSA_PROVENANCE) ||
    typeof url !== "string" ||
    !url.startsWith(ATTESTATIONS_URL)
  ) {
    throw new Error(`registry has malformed attestations for ${name}@${version}`);
  }
  return url;
}

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

/**
 * What a person weighing an early `name@version` may want to know, against
 * the versions it replaces: provenance, a publisher change, install scripts
 * it adds. Information only (the identity checks above are what fail); a
 * fact the registry can't tell is said to be unknown, never guessed.
 */
export function releaseSignals(doc: Packument, name: string, version: string, replaced: ReadonlyArray<string>): string[] {
  const known = replaced.filter((previous) => isObject(doc.versions[previous]));
  const attempt = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const provenance = attempt(() => provenanceUrl(doc, name, version) !== undefined);
  const publisher = attempt(() => publisherOf(doc, name, version));
  const before = [...new Set(known.map((previous) => attempt(() => publisherOf(doc, name, previous)) ?? "unknown"))];
  // Each install script as `name: command`, so a changed command counts as new too.
  const scripts = (of: string) => attempt(() => {
    const declared = manifestDist(doc, name, of).manifest["scripts"];
    return INSTALL_SCRIPTS.flatMap((script) => isObject(declared) && typeof declared[script] === "string" ? [`${script}: ${declared[script]}`] : []);
  });
  const named = (entries: ReadonlyArray<string>) => entries.map((entry) => entry.slice(0, entry.indexOf(":")));
  const current = scripts(version);
  const earlier = new Set(known.flatMap((previous) => scripts(previous) ?? []));
  const now = current === undefined ? undefined : named(current);
  const added = current === undefined ? undefined : named(current.filter((entry) => !earlier.has(entry)));
  return [
    provenance === undefined ? "provenance unknown" : provenance ? "has provenance" : "no provenance",
    publisher === undefined ? "publisher unknown"
      : known.length === 0 ? `published by ${publisher}`
      : before.every((name) => name === publisher) ? `published by ${publisher}, as before`
      : `publisher changed: ${publisher} (before: ${before.join(", ")})`,
    added === undefined ? "install scripts unknown"
      : now!.length === 0 ? "no install scripts"
      : known.length === 0 ? `install scripts: ${now!.join(", ")}`
      : added.length > 0 ? `adds or changes install scripts: ${added.join(", ")}`
      : `install scripts as before: ${now!.join(", ")}`,
  ];
}

function publisherOf(doc: Packument, name: string, version: string): string | undefined {
  const user = manifestDist(doc, name, version).manifest["_npmUser"];
  const publisher = isObject(user) ? user["name"] : undefined;
  return typeof publisher === "string" && publisher !== "" ? publisher : undefined;
}

/** What the gate reads from a provenance statement. */
interface Statement {
  /** The single subject's package URL, e.g. `pkg:npm/%40scope/name@1.0.0`. */
  readonly subject: string;
  /** The subject's sha512 digest, hex. */
  readonly sha512: string;
  readonly source: Provenance;
}

interface Provenance {
  /** `repository (workflow path)`, as the statement names them. */
  readonly source: string;
  /** `owner/repo` in lower case, comparable with a manifest's `repository`. */
  readonly repository: string | undefined;
}

async function fetchStatement(url: string, fetch: Fetch): Promise<Statement> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`attestation lookup ${url} failed with HTTP ${response.status}`);
  const json = await response.json();
  const attestations = isObject(json) ? json["attestations"] : undefined;
  const entry = Array.isArray(attestations)
    ? attestations.find(
        (item: unknown) => isObject(item) && typeof item["predicateType"] === "string" && item["predicateType"].startsWith(SLSA_PROVENANCE),
      )
    : undefined;
  const payload = dig(entry, ["bundle", "dsseEnvelope", "payload"]);
  let statement: unknown;
  try {
    statement = typeof payload === "string" ? JSON.parse(Buffer.from(payload, "base64").toString("utf8")) : undefined;
  } catch {
    statement = undefined;
  }
  const subjects = dig(statement, ["subject"]);
  const subject = Array.isArray(subjects) && subjects.length === 1 ? dig(subjects[0], ["name"]) : undefined;
  const sha512 = Array.isArray(subjects) && subjects.length === 1 ? dig(subjects[0], ["digest", "sha512"]) : undefined;
  const workflow = dig(statement, ["predicate", "buildDefinition", "externalParameters", "workflow"]);
  const repository = dig(workflow, ["repository"]);
  const path = dig(workflow, ["path"]);
  if (
    typeof subject !== "string" ||
    typeof sha512 !== "string" ||
    typeof repository !== "string" ||
    repository === "" ||
    typeof path !== "string" ||
    path === ""
  ) {
    throw new Error(`unrecognized provenance at ${url}`);
  }
  return {
    subject,
    sha512: sha512.toLowerCase(),
    source: { source: `${repository} (${path})`, repository: githubRepository(repository) },
  };
}

/** The hex sha512 in a subresource-integrity string, if it has one. */
function sha512Hex(integrity: string | undefined): string | undefined {
  const entry = integrity?.split(/\s+/).find((hash) => hash.startsWith("sha512-"));
  return entry === undefined ? undefined : Buffer.from(entry.slice("sha512-".length), "base64").toString("hex");
}

/**
 * `owner/repo` (lower case) of a GitHub repository URL or manifest
 * `repository` field; undefined otherwise. Stricter than the source-repository
 * lookup on purpose: identity checks compare it.
 */
function githubRepository(value: unknown): string | undefined {
  const raw = isObject(value) ? value["url"] : value;
  if (typeof raw !== "string") return undefined;
  const match =
    /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(raw) ??
    /^(?:git@github\.com:|github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(raw);
  return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase();
}

export function publishTime(doc: Packument, name: string, version: string): Date {
  const time = doc.times[version];
  // Only an ISO timestamp string: `new Date(null | 0 | false)` would be 1970 and pass the wait.
  const published = typeof time === "string" && /^\d{4}-\d{2}-\d{2}T/.test(time) ? new Date(time) : undefined;
  if (published === undefined || Number.isNaN(published.getTime())) {
    throw new Error(`registry has no valid publish time for ${name}@${version}`);
  }
  return published;
}
