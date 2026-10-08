/**
 * Version ordering per ecosystem: npm follows SemVer 2.0 precedence, GitHub
 * Actions too on their tags (`v7.0.1`; `v4` reads as 4.0.0), Maven follows
 * Maven's `ComparableVersion` (numbers, then the
 * qualifiers alpha < beta < milestone < rc < snapshot < release < sp, unknown
 * qualifiers after those, lexically).
 *
 * Besides ordering, each scheme names a version's compatible line (the range a
 * security fix should stay in first: npm's caret range, Maven's first numeric
 * segment), whether it's a prerelease, and its flavor (Maven qualifiers such as
 * Guava's `-jre`, which candidates must keep).
 */

export type Ecosystem = "npm" | "Maven" | "GitHub Actions";

export const ECOSYSTEMS: ReadonlyArray<Ecosystem> = ["npm", "Maven", "GitHub Actions"];

export interface VersionScheme {
  /** Negative, zero or positive, like a sort comparator. */
  compare(a: string, b: string): number;
  /** The compatible line, e.g. `1` for 1.9.4, `0.14` for 0.14.2. */
  line(version: string): string;
  isPrerelease(version: string): boolean;
  /** Qualifiers that name a variant rather than a stage (`jre`, `android`); empty when none. */
  flavor(version: string): string;
}

export function versionScheme(ecosystem: Ecosystem): VersionScheme {
  return ecosystem === "npm" ? SEMVER : ecosystem === "Maven" ? MAVEN : ACTIONS;
}

// ---------------------------------------------------------------------------
// npm: SemVer 2.0

interface SemVer {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly prerelease: ReadonlyArray<string>;
}

const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function parseSemVer(version: string): SemVer {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) throw new Error(`not a SemVer version: ${version}`);
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

export function isSemVer(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return compareBigInt(BigInt(a), BigInt(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  const core = compareBigInt(a.major, b.major) || compareBigInt(a.minor, b.minor) || compareBigInt(a.patch, b.patch);
  if (core !== 0) return core;
  if (a.prerelease.length === 0) return b.prerelease.length === 0 ? 0 : 1;
  if (b.prerelease.length === 0) return -1;
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const result = comparePrereleaseIdentifier(a.prerelease[i]!, b.prerelease[i]!);
    if (result !== 0) return result;
  }
  return a.prerelease.length - b.prerelease.length;
}

const SEMVER: VersionScheme = {
  compare: compareSemVer,
  line(version) {
    const { major, minor, patch } = parseSemVer(version);
    if (major > 0n) return `${major}`;
    if (minor > 0n) return `0.${minor}`;
    return `0.0.${patch}`;
  },
  isPrerelease: (version) => parseSemVer(version).prerelease.length > 0,
  flavor: () => "",
};

// ---------------------------------------------------------------------------
// GitHub Actions: SemVer on tags, without the `v`, partial tags padded

/** `v7.0.1` → `7.0.1`, `v4` → `4.0.0`, `4.1` → `4.1.0`; anything else is left as is (and won't parse). */
export function actionTagToSemVer(tag: string): string {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+].*)?$/.exec(tag);
  if (match === null) return tag;
  return `${match[1]}.${match[2] ?? "0"}.${match[3] ?? "0"}${match[4] ?? ""}`;
}

const ACTIONS: VersionScheme = {
  compare: (a, b) => SEMVER.compare(actionTagToSemVer(a), actionTagToSemVer(b)),
  line: (version) => SEMVER.line(actionTagToSemVer(version)),
  isPrerelease: (version) => SEMVER.isPrerelease(actionTagToSemVer(version)),
  flavor: () => "",
};

// ---------------------------------------------------------------------------
// Maven: ComparableVersion

type MavenItem =
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "list"; readonly items: MavenItem[] };

const QUALIFIERS = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];
const RELEASE_INDEX = String(QUALIFIERS.indexOf(""));
const ALIASES: Readonly<Record<string, string>> = { ga: "", final: "", release: "", cr: "rc" };
const PRERELEASE_QUALIFIERS = new Set(["alpha", "beta", "milestone", "rc", "snapshot", "preview", "ea", "dev", "pre"]);

function stringItem(value: string, followedByDigit: boolean): MavenItem {
  let qualifier = value;
  if (followedByDigit && qualifier.length === 1) {
    qualifier = qualifier === "a" ? "alpha" : qualifier === "b" ? "beta" : qualifier === "m" ? "milestone" : qualifier;
  }
  return { kind: "string", value: ALIASES[qualifier] ?? qualifier };
}

function parseItem(isDigit: boolean, text: string): MavenItem {
  return isDigit ? { kind: "int", value: BigInt(text) } : stringItem(text, false);
}

function comparableQualifier(qualifier: string): string {
  const index = QUALIFIERS.indexOf(qualifier);
  return index === -1 ? `${QUALIFIERS.length}-${qualifier}` : String(index);
}

function isNullItem(item: MavenItem): boolean {
  if (item.kind === "int") return item.value === 0n;
  if (item.kind === "string") return comparableQualifier(item.value) === RELEASE_INDEX;
  return item.items.length === 0;
}

/** Drops trailing null items (`0`, release qualifiers, empty lists) up to the last non-list item. */
function normalize(list: MavenItem[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]!;
    if (isNullItem(item)) list.splice(i, 1);
    else if (item.kind !== "list") break;
  }
}

export function parseMavenVersion(version: string): MavenItem[] {
  const text = version.toLowerCase();
  const root: MavenItem[] = [];
  let list = root;
  const stack: MavenItem[][] = [root];
  const startSublist = (): void => {
    const sublist: MavenItem[] = [];
    list.push({ kind: "list", items: sublist });
    list = sublist;
    stack.push(sublist);
  };
  let isDigit = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === ".") {
      list.push(i === start ? { kind: "int", value: 0n } : parseItem(isDigit, text.slice(start, i)));
      start = i + 1;
    } else if (c === "-") {
      list.push(i === start ? { kind: "int", value: 0n } : parseItem(isDigit, text.slice(start, i)));
      start = i + 1;
      startSublist();
    } else if (c >= "0" && c <= "9") {
      if (!isDigit && i > start) {
        list.push(stringItem(text.slice(start, i), true));
        start = i;
        startSublist();
      }
      isDigit = true;
    } else {
      if (isDigit && i > start) {
        list.push(parseItem(true, text.slice(start, i)));
        start = i;
        startSublist();
      }
      isDigit = false;
    }
  }
  if (text.length > start) {
    // Maven 3.9: a trailing `.X` qualifier counts as `-X`, so 2.0.a < 2-1.
    if (!isDigit && list.length > 0) startSublist();
    list.push(parseItem(isDigit, text.slice(start)));
  }
  for (const pending of stack.reverse()) normalize(pending);
  return root;
}

function compareItem(left: MavenItem | undefined, right: MavenItem | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -compareItem(right, undefined);
  if (left.kind === "int") {
    if (right === undefined) return left.value === 0n ? 0 : 1;
    return right.kind === "int" ? compareBigInt(left.value, right.value) : 1;
  }
  if (left.kind === "string") {
    if (right === undefined) return compareStrings(comparableQualifier(left.value), RELEASE_INDEX);
    if (right.kind === "string") return compareStrings(comparableQualifier(left.value), comparableQualifier(right.value));
    return -1;
  }
  if (right === undefined) return left.items.length === 0 ? 0 : compareItem(left.items[0], undefined);
  if (right.kind === "int") return -1;
  if (right.kind === "string") return 1;
  return compareLists(left.items, right.items);
}

function compareLists(left: ReadonlyArray<MavenItem>, right: ReadonlyArray<MavenItem>): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const result = compareItem(left[i], right[i]);
    if (result !== 0) return result;
  }
  return 0;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function mavenQualifiers(items: ReadonlyArray<MavenItem>): string[] {
  return items.flatMap((item) =>
    item.kind === "string" ? [item.value] : item.kind === "list" ? mavenQualifiers(item.items) : [],
  );
}

const MAVEN: VersionScheme = {
  compare: (a, b) => compareLists(parseMavenVersion(a), parseMavenVersion(b)),
  line(version) {
    const items = parseMavenVersion(version);
    const first = items[0];
    if (first === undefined) return "0";
    if (first.kind !== "int") return version;
    if (first.value > 0n) return `${first.value}`;
    const second = items[1];
    return second?.kind === "int" ? `0.${second.value}` : "0";
  },
  isPrerelease: (version) => mavenQualifiers(parseMavenVersion(version)).some((q) => PRERELEASE_QUALIFIERS.has(q)),
  flavor: (version) =>
    [...new Set(mavenQualifiers(parseMavenVersion(version)).filter((q) => q !== "" && q !== "sp" && !PRERELEASE_QUALIFIERS.has(q)))]
      .sort()
      .join("+"),
};

// ---------------------------------------------------------------------------
// Advisory ranges, as GitHub's database writes them (`>= 1.0.0, < 1.2.2`, the
// comma meaning AND) and as maintainers write them in repository advisories
// (`< 1.1.21, >= 2.0.0 < 2.1.7`, the comma meaning OR; `4.0.0 - 5.0.7`).

export interface Bound {
  readonly version: string;
  readonly inclusive: boolean;
}

export interface Interval {
  readonly lower: Bound | undefined;
  readonly upper: Bound | undefined;
}

/**
 * The range as a union of intervals: each lower bound opens an interval the
 * next upper bound closes (a lone upper bound starts at zero, a lone lower
 * bound runs to infinity). A bare version followed by an upper bound is a
 * lower bound (`4.0.0 < 4.1.2`); a bare partial npm version is its X-range
 * (`6` and `6.x` are 6.x, also in `6 <=6.1.8`); any other bare version is a single point.
 * `,` and `;` separate bounds; `||` also ends any open interval. That reading
 * gives the same answer for both comma conventions whenever the range is well
 * formed (an inverted interval, `>= 2.0.0, < 1.0.0`, reads as both open
 * ends). Undefined when anything in it doesn't parse.
 */
export function parseAdvisoryRange(range: string, partialsAreXRanges = false): Interval[] | undefined {
  const segments = range.split("||");
  const intervals: Interval[] = [];
  for (const segment of segments) {
    const parsed = parseSegment(segment, partialsAreXRanges);
    if (parsed === undefined) return undefined;
    intervals.push(...parsed);
  }
  return intervals.length === 0 ? undefined : intervals;
}

/** One `||`-separated part: commas, semicolons and spaces inside it follow the interval reading above. */
function parseSegment(segment: string, partialsAreXRanges: boolean): Interval[] | undefined {
  const normalized = segment
    .replaceAll("≤", "<=")
    .replaceAll("≥", ">=")
    .replace(/\s*[–—]\s*/g, " - ")
    .replace(/(\S+)\s+-\s+(\S+)/g, ">=$1 <=$2")
    .replace(/[,;]/g, " ")
    .replace(/([0-9A-Za-z])(<=|>=|<|>)/g, "$1 $2")
    .replace(/(<=|>=|<|>|=)\s+/g, "$1")
    .replace(/(^|\s)(\d+(?:\.\d+)?)\.[xX*](?=\s|$)/g, "$1$2");
  const raw = normalized.split(/\s+/).filter((token) => token !== "");
  if (raw.length === 0) return undefined;
  const tokens: Array<{ operator: string | undefined; version: string }> = [];
  for (const token of raw) {
    const match = /^(<=|>=|<|>|=)?v?(\d[0-9A-Za-z.+_-]*)$/.exec(token);
    if (match === null) return undefined;
    tokens.push({ operator: match[1], version: match[2]! });
  }
  const isUpper = (operator: string | undefined) => operator === "<" || operator === "<=";
  const intervals: Interval[] = [];
  let pending: { lower: Bound; impliedUpper: Bound | undefined } | undefined;
  const flush = () => {
    if (pending !== undefined) intervals.push({ lower: pending.lower, upper: pending.impliedUpper });
    pending = undefined;
  };
  for (const [i, { operator, version }] of tokens.entries()) {
    if (operator === ">=" || operator === ">") {
      flush();
      pending = { lower: { version, inclusive: operator === ">=" }, impliedUpper: undefined };
    } else if (isUpper(operator)) {
      intervals.push({ lower: pending?.lower, upper: { version, inclusive: operator === "<=" } });
      pending = undefined;
    } else {
      flush();
      const partial = partialsAreXRanges && /^\d+(\.\d+)?$/.test(version);
      const nextIsUpper = operator === undefined && isUpper(tokens[i + 1]?.operator);
      if (partial) {
        const parts = version.split(".").map(Number);
        const lower = parts.length === 1 ? `${parts[0]}.0.0` : `${parts[0]}.${parts[1]}.0`;
        const upper = parts.length === 1 ? `${parts[0]! + 1}.0.0-0` : `${parts[0]}.${parts[1]! + 1}.0-0`;
        pending = { lower: { version: lower, inclusive: true }, impliedUpper: { version: upper, inclusive: false } };
      } else if (nextIsUpper) {
        pending = { lower: { version, inclusive: true }, impliedUpper: undefined };
      } else {
        intervals.push({ lower: { version, inclusive: true }, upper: { version, inclusive: true } });
      }
    }
  }
  flush();
  return intervals;
}

/**
 * An interval whose lower bound is above its upper one (`>= 2.0.0, < 1.0.0`)
 * only makes sense with the comma as OR: it reads as both open intervals.
 */
function splitInverted(scheme: VersionScheme): (interval: Interval) => Interval[] {
  return (interval) =>
    interval.lower !== undefined && interval.upper !== undefined && scheme.compare(interval.lower.version, interval.upper.version) > 0
      ? [
          { lower: interval.lower, upper: undefined },
          { lower: undefined, upper: interval.upper },
        ]
      : [interval];
}

/**
 * A flavored version (`33.7.1-jre`) against a bound without that flavor
 * (`33.7.1`) compares as the plain version: `4.0–33.7.1` includes 33.7.1-jre,
 * which Maven's ordering would put after 33.7.1.
 */
function comparableTo(scheme: VersionScheme, version: string, bound: string): string {
  const flavor = scheme.flavor(version);
  if (flavor === "" || flavor.includes("+") || scheme.flavor(bound) !== "") return version;
  const cut = version.toLowerCase().lastIndexOf(flavor);
  return cut > 0 && cut + flavor.length === version.length && "-.".includes(version[cut - 1]!) ? version.slice(0, cut - 1) : version;
}

/** Whether `version` falls in the advisory range; undefined when the range doesn't parse (a coverage gap). */
export function inAdvisoryRange(scheme: VersionScheme, range: string, version: string): boolean | undefined {
  const intervals = parseAdvisoryRange(range, scheme === SEMVER);
  if (intervals === undefined) return undefined;
  try {
    const order = (bound: string) => scheme.compare(comparableTo(scheme, version, bound), bound);
    return intervals.flatMap(splitInverted(scheme)).some(({ lower, upper }) => {
      const aboveLower = lower === undefined || (lower.inclusive ? order(lower.version) >= 0 : order(lower.version) > 0);
      const belowUpper = upper === undefined || (upper.inclusive ? order(upper.version) <= 0 : order(upper.version) < 0);
      return aboveLower && belowUpper;
    });
  } catch {
    return undefined;
  }
}
