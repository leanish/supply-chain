/**
 * Whether the default branch's daily scan still runs: the last successful
 * scheduled run that calls the gate on the base, read with
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
  const started = await lastGateRun(repo, base, token, fetch);
  if (started === undefined) return { stale: true, lastSuccess: undefined, detail: `no scheduled supply-chain run on ${base} has succeeded yet` };
  const date = new Date(started);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid scheduled scan time for ${repo}: ${started}`);
  const hours = (now.getTime() - date.getTime()) / 3_600_000;
  return hours > maxHours
    ? { stale: true, lastSuccess: started, detail: `the last successful scheduled scan of ${base} ran ${Math.floor(hours)} hours ago (more than ${maxHours})` }
    : { stale: false, lastSuccess: started, detail: `the last successful scheduled scan of ${base} ran ${Math.floor(hours)} hours ago` };
}

interface ScheduledRun {
  readonly run_started_at?: string;
  readonly created_at?: string;
  readonly referenced_workflows?: ReadonlyArray<{ readonly path?: string }>;
}

/** GitHub reports the called reusable workflow even when the caller is ci.yml or another file. */
async function lastGateRun(repo: string, base: string, token: string, fetch: typeof globalThis.fetch): Promise<string | undefined> {
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repo}/actions/runs?branch=${encodeURIComponent(base)}&event=schedule&status=success&per_page=100&page=${page}`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`reading ${repo}'s scheduled supply-chain runs failed (HTTP ${response.status})`);
    const runs = ((await response.json()) as { workflow_runs?: ScheduledRun[] }).workflow_runs ?? [];
    const gate = runs.find((run) => run.referenced_workflows?.some((workflow) =>
      workflow.path?.startsWith("leanish/supply-chain/.github/workflows/supply-chain.yml@"),
    ));
    if (gate !== undefined) return gate.run_started_at ?? gate.created_at;
    if (runs.length < 100) return undefined;
  }
}
