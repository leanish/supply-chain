/** The slice of `fetch` the gate uses, so tests can fake every registry and API. */
export type Fetch = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * `fetch` whose network errors name the request: undici's own message is just
 * "fetch failed", with the reason (a reset, a DNS error) in its `cause`.
 */
export function namingFailures(fetch: Fetch): Fetch {
  return async (url, init) => {
    try {
      return await fetch(url, init);
    } catch (err) {
      const cause = (err as Error).cause;
      const reason = cause instanceof Error ? cause.message : (err as Error).message;
      throw new Error(`${init?.method ?? "GET"} ${url} failed: ${reason}`, { cause: err });
    }
  };
}

/** Runs `work` over `items` with at most `limit` in flight, keeping input order in the result. */
export async function mapLimited<T, R>(items: ReadonlyArray<T>, limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
