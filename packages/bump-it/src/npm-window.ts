/** Keep npm's age filter from rejecting locked young versions; target selection still checks age. */
import semver from "semver";

import { mapLimited } from "../../ci/src/http.ts";

import type { NpmCommand } from "./npm-compute.ts";
import type { TargetSources } from "./npm-targets.ts";

interface NpmWindow {
  readonly days: number;
  readonly exclude: ReadonlyArray<string>;
}

interface PreparedWindow {
  readonly window: NpmWindow;
  readonly sources: TargetSources;
  readonly notes: ReadonlyArray<string>;
  readonly reason: string;
}

const DAY_MS = 86_400_000;

export async function npmWindowFor(baseVersions: ReadonlyMap<string, ReadonlyArray<string>>, window: NpmWindow, sources: TargetSources): Promise<PreparedWindow> {
  const cached = cachedPublishTimes(sources);
  const lockedVersions = [...baseVersions].flatMap(([name, versions]) => versions.map((version) => ({ name, version })));
  const checked = await mapLimited(lockedVersions, 8, async ({ name, version }) => ({
    name,
    note: await baseExclusionNote(name, version, window.days, cached),
  }));
  const excluded = checked.filter((entry): entry is { name: string; note: string } => entry.note !== undefined);
  const notes = excluded.map((entry) => entry.note);
  const reasons: string[] = [];
  if (window.exclude.length > 0) {
    reasons.push("configured own-package exclusions");
  }
  if (notes.length > 0) {
    reasons.push("young or unreadable locked versions");
  }
  return {
    window: { ...window, exclude: [...new Set([...window.exclude, ...excluded.map((entry) => entry.name)])].sort() },
    sources: cached,
    notes,
    reason: reasons.join(" and "),
  };
}

function cachedPublishTimes(sources: TargetSources): TargetSources {
  const times = new Map<string, Promise<Date | undefined>>();
  return {
    ...sources,
    published(name, version) {
      const key = JSON.stringify([name, version]);
      let found = times.get(key);
      if (found === undefined) {
        found = Promise.resolve().then(() => sources.published(name, version));
        times.set(key, found);
      }
      return found;
    },
  };
}

async function baseExclusionNote(name: string, version: string, days: number, sources: TargetSources): Promise<string | undefined> {
  let published: Date | undefined;
  try {
    published = await sources.published(name, version);
  } catch {
    // An unreadable publish time must not make npm reject a version already locked in base.
  }
  const time = published?.getTime();
  if (time === undefined || !Number.isFinite(time)) {
    return `${name}: publish time for its locked ${version} could not be read, so npm's own window skips it; bump-it's targets still require the age`;
  }
  if (sources.now.getTime() - time >= days * DAY_MS) {
    return undefined;
  }
  return `${name}: its locked ${version} is younger than the window, so npm's own window skips it; bump-it's targets still require the age`;
}

export async function requireNpmExcludes(npm: NpmCommand, dir: string, exclude: ReadonlyArray<string>, reason = "release-age exclusions"): Promise<void> {
  if (exclude.length === 0) {
    return;
  }
  const result = await npm(dir, ["--version"]);
  const version = semver.valid(result.stdout.trim());
  if (result.code !== 0 || version === null || !semver.gte(version, "11.17.0")) {
    const detected = result.stdout.trim() || result.stderr.trim() || "no version";
    throw new Error(`${reason} require npm >= 11.17.0 (min-release-age-exclude: ${exclude.join(", ")}); got ${detected}`);
  }
}
