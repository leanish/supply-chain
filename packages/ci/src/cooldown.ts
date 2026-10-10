/**
 * The cooldown: every version a change adds or changes that is younger than
 * `releaseAgeDays` is held, however the release-age rule let it through (the
 * security fix the rule picks, a version that fix requires, an exception).
 * Needing a version doesn't make it safe: whoever controls a publisher can put
 * malware in a real fix, whatever the advisory's severity. The `supply-chain`
 * verdict says whether the change is right; the separate `cooldown` check
 * stays red while anything is held, so taking it earlier is a person's
 * explicit decision.
 *
 * The policy that judges a PR is the stricter of base's and head's: the
 * longer wait, and own packages only where both name them, so a PR can't
 * loosen the cooldown that judges it.
 */
import type { Config } from "./config.ts";
import { isObject } from "./json.ts";
import type { HeldVersion, YoungJustification } from "./release-age.ts";
import { REPORT_SCHEMA_VERSION } from "./report.ts";
import type { Ecosystem } from "./versions.ts";

export type CooldownEvaluation =
  | { readonly evaluated: true; readonly releaseAgeDays: number; readonly held: ReadonlyArray<HeldVersion> }
  | { readonly evaluated: false; readonly reason: string };

/** Held versions, from a report the gate wrote for exactly this head. */
export interface CooldownVerdict {
  readonly releaseAgeDays: number;
  readonly held: ReadonlyArray<HeldVersion>;
}

export function strictestPolicy(head: Config, base: Config): Config {
  return {
    ...head,
    releaseAgeDays: Math.max(head.releaseAgeDays, base.releaseAgeDays),
    // Own only where both sides say so: `isOwnPackage` checks head's lists, then base's.
    ownPackages: { ...head.ownPackages, alsoOwnedBy: base.ownPackages },
  };
}

/** When the last held version turns old enough; undefined when nothing is held. */
export function heldUntil(held: ReadonlyArray<HeldVersion>): string | undefined {
  return held.reduce<string | undefined>((latest, entry) => (latest === undefined || entry.eligibleAt > latest ? entry.eligibleAt : latest), undefined);
}

/**
 * The cooldown in a `compare` report, or why it can't be trusted: the report
 * must be complete, passing, for `expectedHead`, and its cooldown evaluated.
 * A report without one (an older gate) is an error, never "nothing held".
 */
export function cooldownOf(raw: unknown, expectedHead: string): CooldownVerdict {
  if (!isObject(raw)) throw new Error("the report isn't a JSON object");
  if (raw["schemaVersion"] !== REPORT_SCHEMA_VERSION) throw new Error(`the report's schemaVersion isn't ${REPORT_SCHEMA_VERSION}`);
  if (raw["mode"] !== "compare") throw new Error("the report isn't a comparison");
  if (raw["headSha"] !== expectedHead) throw new Error(`the report is for ${String(raw["headSha"])}, not ${expectedHead}`);
  if (raw["completed"] !== true || raw["verdict"] !== "pass") throw new Error("the comparison didn't complete with a pass");
  const cooldown = raw["cooldown"];
  if (!isObject(cooldown)) throw new Error("the report has no cooldown");
  if (cooldown["evaluated"] === false) throw new Error(`the cooldown wasn't evaluated: ${String(cooldown["reason"])}`);
  if (cooldown["evaluated"] !== true) throw new Error("the report's cooldown is malformed");
  const days = cooldown["releaseAgeDays"];
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0) throw new Error("the report's cooldown has no valid releaseAgeDays");
  const held = cooldown["held"];
  if (!Array.isArray(held)) throw new Error("the report's cooldown has no held list");
  return { releaseAgeDays: days, held: held.map(heldEntry) };
}

const ECOSYSTEMS: ReadonlySet<string> = new Set<Ecosystem>(["npm", "Maven", "GitHub Actions"]);
const JUSTIFICATIONS: ReadonlySet<string> = new Set<YoungJustification>(["security-fix", "bundle-fix", "required", "exception", "unjustified"]);

/** One held entry, validated field by field. */
export function heldEntry(raw: unknown): HeldVersion {
  if (!isObject(raw)) throw new Error("a held entry isn't an object");
  const text = (key: string) => {
    const value = raw[key];
    if (typeof value !== "string" || value.length === 0) throw new Error(`a held entry has no ${key}`);
    return value;
  };
  const instant = (key: string) => {
    const value = text(key);
    if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`a held entry's ${key} isn't an ISO instant`);
    return value;
  };
  const ecosystem = text("ecosystem");
  if (!ECOSYSTEMS.has(ecosystem)) throw new Error(`a held entry has an unknown ecosystem ${ecosystem}`);
  const justification = text("justification");
  if (!JUSTIFICATIONS.has(justification)) throw new Error(`a held entry has an unknown justification ${justification}`);
  const replaced = raw["replaced"];
  if (!Array.isArray(replaced) || !replaced.every((version) => typeof version === "string")) throw new Error("a held entry has no replaced list");
  return {
    ecosystem: ecosystem as Ecosystem,
    name: text("name"),
    version: text("version"),
    replaced: replaced as string[],
    published: instant("published"),
    eligibleAt: instant("eligibleAt"),
    justification: justification as YoungJustification,
  };
}

const WHY: Readonly<Record<YoungJustification, string>> = {
  "security-fix": "the security fix the version rule picks",
  "bundle-fix": "the carrier version the rule picks for advisories in its bundle",
  required: "required by a security fix",
  exception: "a release-age exception",
  unjustified: "not justified (the supply-chain check fails too)",
};

/** One line per held version, for logs and annotations. */
export function heldLines(held: ReadonlyArray<HeldVersion>): string[] {
  return held.map((entry) => `${entry.ecosystem} ${entry.name}@${entry.version}: published ${entry.published}, held until ${entry.eligibleAt} (${WHY[entry.justification]})`);
}
