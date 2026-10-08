/**
 * Gradle's own version ordering, which isn't Maven's: what conflict
 * resolution uses to pick the highest requested version, so the floors check
 * reads "resolved ≥ floor" the way Gradle does. From Gradle's "Version
 * ordering" rules:
 *   - `.`, `-`, `_` and `+` separate parts, and so does every switch between
 *     digits and letters (`1a1` is `1.a.1`);
 *   - numeric parts compare numerically, and beat non-numeric ones;
 *   - non-numeric parts compare case-sensitively, except the special ones:
 *     `dev` is below every other, and `rc` < `snapshot` < `final` < `ga` <
 *     `release` < `sp` are above every other (case-insensitive);
 *   - an extra numeric part makes a version higher (`1.1` < `1.1.0`); an
 *     extra non-numeric part makes it lower (`1.1.a` < `1.1`).
 */

const SPECIAL_HIGH = ["rc", "snapshot", "final", "ga", "release", "sp"];

type Part = { readonly numeric: true; readonly value: bigint } | { readonly numeric: false; readonly value: string };

function parts(version: string): Part[] {
  return (version.match(/\d+|[^\d.\-_+]+/g) ?? []).map((part) =>
    /^\d+$/.test(part) ? { numeric: true, value: BigInt(part) } : { numeric: false, value: part },
  );
}

/** -1 for `dev`, 1 + index for the high specials, 0 for an ordinary string. */
function rank(part: string): number {
  const lower = part.toLowerCase();
  if (lower === "dev") return -1;
  const index = SPECIAL_HIGH.indexOf(lower);
  return index === -1 ? 0 : 1 + index;
}

function compareStringParts(a: string, b: string): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra !== 0) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareGradleVersions(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.numeric && y.numeric) {
      if (x.value !== y.value) return x.value < y.value ? -1 : 1;
    } else if (x.numeric !== y.numeric) {
      return x.numeric ? 1 : -1;
    } else {
      const result = compareStringParts(x.value as string, y.value as string);
      if (result !== 0) return result;
    }
  }
  if (a.length === b.length) return 0;
  const longer = a.length > b.length ? a : b;
  const extra = longer[Math.min(a.length, b.length)]!;
  // An extra numeric part is higher; an extra non-numeric part is lower.
  const longerIsHigher = extra.numeric;
  return (a.length > b.length) === longerIsHigher ? 1 : -1;
}
