/**
 * Whether the default branch's daily scan still runs: the last successful
 * scheduled run of `.github/workflows/supply-chain.yml` on the base, read with
 * the read-only token. GitHub can skip scheduled runs and disables them after
 * 60 days without activity in a public repository; this is the warning for
 * that. If secure-it doesn't run either, nothing warns (the docs say so).
 */
export interface StaleScan {
  readonly stale: boolean;
  /** When the last successful scheduled scan ran; undefined when none did. */
  readonly lastSuccess: string | undefined;
  readonly detail: string;
}

export async function staleScanStatus(
  repo: string,
  base: string,
  token: string,
  now: Date,
  maxHours: number,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<StaleScan> {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/supply-chain.yml/runs?branch=${encodeURIComponent(base)}&event=schedule&status=success&per_page=1`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return { stale: true, lastSuccess: undefined, detail: `${repo} has no .github/workflows/supply-chain.yml, so nothing scans ${base} daily` };
  if (!response.ok) throw new Error(`reading ${repo}'s scheduled supply-chain runs failed (HTTP ${response.status})`);
  const runs = ((await response.json()) as { workflow_runs?: Array<{ run_started_at?: unknown; created_at?: unknown }> }).workflow_runs ?? [];
  const started = runs[0]?.run_started_at ?? runs[0]?.created_at;
  if (typeof started !== "string") return { stale: true, lastSuccess: undefined, detail: `no scheduled supply-chain run on ${base} has succeeded yet` };
  const hours = (now.getTime() - new Date(started).getTime()) / 3_600_000;
  return hours > maxHours
    ? { stale: true, lastSuccess: started, detail: `the last successful scheduled scan of ${base} ran ${Math.floor(hours)} hours ago (more than ${maxHours})` }
    : { stale: false, lastSuccess: started, detail: `the last successful scheduled scan of ${base} ran ${Math.floor(hours)} hours ago` };
}
