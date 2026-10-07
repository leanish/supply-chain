/** Select stable, aged Gradle releases on one repository-advisory snapshot; verify official wrapper artifacts. */
import type { GateEnvironment } from "../../ci/src/gate.ts";
import { isObject } from "../../ci/src/json.ts";
import { fetchRepositoryAdvisories, type RepositoryAdvisory } from "../../ci/src/repository-advisories.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { inAdvisoryRange, parseAdvisoryRange, versionScheme } from "../../ci/src/versions.ts";

import type { DirectMove } from "./units.ts";
import { wrapperProperties } from "./wrapper-properties.ts";

export const WRAPPER_PROPERTIES = "gradle/wrapper/gradle-wrapper.properties";
export const WRAPPER_JAR = "gradle/wrapper/gradle-wrapper.jar";
export const WRAPPER_FILES: ReadonlyArray<string> = [WRAPPER_PROPERTIES, WRAPPER_JAR, "gradlew", "gradlew.bat"];
export const WRAPPER_PACKAGE = "Gradle Wrapper|gradle/gradle";
const SERVICES = "https://services.gradle.org";
const SCHEME = versionScheme("Maven");

export interface WrapperTarget {
  readonly distributionUrl: string;
  readonly distributionSha256: string;
  readonly jarSha256: string;
}

export interface WrapperCandidates {
  readonly routine?: DirectMove;
  readonly major?: DirectMove;
  readonly notes?: ReadonlyArray<string>;
  readonly unavailable?: boolean;
}

export interface WrapperPlanner {
  candidates(tree: Tree): Promise<WrapperCandidates>;
  verify(moves: ReadonlyArray<DirectMove>, base: Tree, head: Tree, jarSha256: string | undefined): Promise<string[]>;
}

interface Release {
  readonly version: string;
  readonly built: Date;
  readonly metadata: Record<string, unknown>;
}

interface ReleaseCatalog {
  readonly releases: Release[];
  readonly notes: string[];
}

interface CurrentWrapper {
  readonly version: string;
  readonly type: "bin" | "all";
}

/** The catalog and advisories are fetched lazily once, even when a tick recomputes several PRs. */
export function gradleWrapperPlanner(env: GateEnvironment, releaseAgeDays: number): WrapperPlanner {
  let snapshot: Promise<ReleaseCatalog & { advisories: ReadonlyArray<RepositoryAdvisory> }> | undefined;
  const now = env.now();
  const targets = new Map<string, Promise<WrapperTarget>>();
  const readSnapshot = () => snapshot ??= Promise.all([
    releasesOf(env),
    fetchRepositoryAdvisories("gradle/gradle", { fetch: env.fetch, token: env.githubToken }),
  ]).then(([catalog, advisories]) => {
    if (advisories === undefined) throw new Error("gradle/gradle's published advisories could not be read");
    return { ...catalog, advisories };
  });
  const target = (release: Release, type: CurrentWrapper["type"]) => {
    const key = `${release.version}-${type}`;
    let found = targets.get(key);
    if (found === undefined) {
      found = officialTarget(release, type, env);
      targets.set(key, found);
    }
    return found;
  };
  const aged = (release: Release) => now.getTime() - release.built.getTime() >= releaseAgeDays * 86_400_000;

  return {
    async candidates(tree) {
      try {
        const current = await currentWrapper(tree);
        if (current === undefined) {
          return {};
        }
        const { releases, advisories, notes } = await readSnapshot();
        const inherited = affecting(advisories, current.version);
        const eligible = releases.filter((release) => SCHEME.compare(release.version, current.version) > 0 && aged(release) &&
          affecting(advisories, release.version).every((id) => inherited.includes(id)));
        const routine = eligible.find((release) => majorOf(release.version) === majorOf(current.version));
        const major = eligible.find((release) => majorOf(release.version) > majorOf(current.version));
        const move = async (release: Release, major: boolean): Promise<DirectMove> => ({
          ecosystem: "Gradle Wrapper", name: "gradle/gradle", from: current.version, to: release.version,
          mechanism: "gradle-wrapper", major, locations: [WRAPPER_PROPERTIES], declarations: [],
          wrapper: await target(release, current.type),
        });
        return {
          ...(notes.length === 0 ? {} : { notes }),
          ...(routine === undefined ? {} : { routine: await move(routine, false) }),
          ...(major === undefined ? {} : { major: await move(major, true) }),
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { unavailable: true, notes: [`Gradle wrapper left out: ${reason}`] };
      }
    },
    async verify(moves, base, head, jarSha256) {
      const selected = moves.filter((move) => move.mechanism === "gradle-wrapper");
      if (selected.length === 0) {
        return [];
      }
      if (selected.length !== 1) {
        return ["exactly one root Gradle wrapper move is required"];
      }
      const move = selected[0]!;
      const current = await currentWrapper(base);
      if (current === undefined || current.version !== move.from) {
        return ["the base wrapper does not match the planned source version"];
      }
      const { releases, advisories } = await readSnapshot();
      const release = releases.find((release) => release.version === move.to);
      if (release === undefined || !aged(release) || SCHEME.compare(move.to, move.from) <= 0) {
        return ["the planned Gradle wrapper target is not a newer stable, non-broken, aged release"];
      }
      if ((majorOf(move.to) > majorOf(move.from)) !== move.major) {
        return ["the wrapper move's major flag does not match its version"];
      }
      const inherited = affecting(advisories, current.version);
      const added = affecting(advisories, move.to).filter((id) => !inherited.includes(id));
      if (added.length > 0) {
        return [`Gradle ${move.to} adds ${added.join(", ")}`];
      }
      const expected = await target(release, current.type);
      const properties = wrapperProperties(await head.read(WRAPPER_PROPERTIES) ?? "");
      const problems: string[] = [];
      if (move.wrapper === undefined || Object.keys(expected).some((key) => expected[key as keyof WrapperTarget] !== move.wrapper![key as keyof WrapperTarget])) {
        problems.push("the wrapper plan does not match services.gradle.org's target metadata");
      }
      if (properties.get("distributionUrl") !== expected.distributionUrl) {
        problems.push(`${WRAPPER_PROPERTIES}: distributionUrl must equal ${expected.distributionUrl}`);
      }
      if (properties.get("distributionSha256Sum") !== expected.distributionSha256) {
        problems.push(`${WRAPPER_PROPERTIES}: distributionSha256Sum must equal the official checksum`);
      }
      if (jarSha256 !== expected.jarSha256) {
        problems.push(`${WRAPPER_JAR} must match the official wrapper checksum`);
      }
      return problems;
    },
  };
}

async function currentWrapper(tree: Tree): Promise<CurrentWrapper | undefined> {
  const text = await tree.read(WRAPPER_PROPERTIES);
  if (text === undefined) return undefined;
  const url = wrapperProperties(text).get("distributionUrl");
  const matched = /^https:\/\/(?:services|downloads)\.gradle\.org\/distributions\/gradle-(\d+(?:\.\d+){1,2})-(bin|all)\.zip$/.exec(url ?? "");
  if (matched === null) throw new Error(`${WRAPPER_PROPERTIES}: expected an official stable Gradle distributionUrl, got ${url ?? "none"}`);
  return { version: matched[1]!, type: matched[2] as CurrentWrapper["type"] };
}

async function releasesOf(env: GateEnvironment): Promise<ReleaseCatalog> {
  const response = await env.fetch(`${SERVICES}/versions/all`);
  if (!response.ok) throw new Error(`Gradle releases failed with HTTP ${response.status}`);
  const entries = await response.json();
  if (!Array.isArray(entries)) throw new Error("Gradle releases are not a list");
  const releases: Release[] = [];
  const notes: string[] = [];
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry["version"] !== "string") throw new Error("Gradle release has no version");
    if (!/^\d+(?:\.\d+){1,2}$/.test(entry["version"]) || entry["snapshot"] !== false || entry["broken"] !== false ||
      entry["nightly"] === true || entry["releaseNightly"] === true || entry["rcFor"] || entry["milestoneFor"]) continue;
    try {
      releases.push({ version: entry["version"], built: buildTime(entry["buildTime"]), metadata: entry });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      notes.push(`Gradle release ${entry["version"]} skipped: ${reason}`);
    }
  }
  return { releases: releases.sort((a, b) => SCHEME.compare(b.version, a.version)), notes };
}

function buildTime(raw: unknown): Date {
  if (typeof raw !== "string" || !/^\d{14}[+-]\d{4}$/.test(raw)) {
    throw new Error(`invalid Gradle buildTime: ${String(raw)}`);
  }
  // Validate the local calendar fields before applying the offset; Date normalizes some invalid dates.
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`;
  const local = new Date(iso);
  const hours = Number(raw.slice(15, 17));
  const minutes = Number(raw.slice(17, 19));
  if (Number.isNaN(local.getTime()) || local.toISOString().slice(0, 19) !== iso.slice(0, 19) || hours > 23 || minutes > 59) {
    throw new Error(`invalid Gradle buildTime: ${raw}`);
  }
  const offset = (hours * 60 + minutes) * (raw[14] === "+" ? 1 : -1);
  return new Date(local.getTime() - offset * 60_000);
}

function majorOf(version: string): number {
  return Number(version.split(".")[0]);
}

/** Repository advisories describe Gradle itself; never silently discard an unreadable published range. */
function affecting(advisories: ReadonlyArray<RepositoryAdvisory>, version: string): string[] {
  return advisories.filter((advisory) => {
    if (advisory.vulnerabilities.length === 0) throw new Error(`${advisory.ghsaId}: no Gradle vulnerability ranges`);
    return advisory.vulnerabilities.map((vulnerability) => {
      const range = vulnerability.range;
      const intervals = range === undefined ? undefined : parseAdvisoryRange(range);
      if (intervals === undefined) throw new Error(`${advisory.ghsaId}: unreadable Gradle advisory range`);
      const hit = inAdvisoryRange(SCHEME, range!, version);
      if (hit === undefined) throw new Error(`${advisory.ghsaId}: unreadable Gradle advisory range`);
      // An open-ended range stops at the maintainer's single patched version, as in the gate.
      if (!hit || vulnerability.patched === undefined || intervals.some((interval) => interval.upper !== undefined)) return hit;
      const patch = vulnerability.patched.trim().replace(/^v/, "");
      if (!/^\d+(?:\.\d+){1,2}$/.test(patch)) throw new Error(`${advisory.ghsaId}: unreadable Gradle patched version`);
      return SCHEME.compare(version, patch) < 0;
    }).some(Boolean);
  }).map((advisory) => advisory.ghsaId);
}

async function officialTarget(release: Release, type: CurrentWrapper["type"], env: GateEnvironment): Promise<WrapperTarget> {
  const distributionUrl = `${SERVICES}/distributions/gradle-${release.version}-${type}.zip`;
  const binUrl = `${SERVICES}/distributions/gradle-${release.version}-bin.zip`;
  if (release.metadata["downloadUrl"] !== binUrl) throw new Error(`Gradle ${release.version}: unexpected official downloadUrl`);
  const checksum = async (field: string, url: string): Promise<string> => {
    let value = type === "all" && field === "checksum" ? undefined : release.metadata[field];
    if (value === undefined || value === "") {
      const response = await env.fetch(url);
      if (!response.ok) throw new Error(`Gradle checksum ${url} failed with HTTP ${response.status}`);
      value = (await response.text()).trim();
    }
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`invalid Gradle ${field} for ${release.version}`);
    return value.toLowerCase();
  };
  return {
    distributionUrl,
    distributionSha256: await checksum("checksum", `${distributionUrl}.sha256`),
    jarSha256: await checksum("wrapperChecksum", `${SERVICES}/distributions/gradle-${release.version}-wrapper.jar.sha256`),
  };
}
