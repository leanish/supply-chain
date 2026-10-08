import type { Fetch } from "../src/http.ts";

export interface FakeResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

/**
 * A fake `fetch` answering from `routes` (exact URL → response, or a function
 * of the URL and request); anything else is a 404. Records every request.
 */
export function fakeFetch(
  routes: Record<string, FakeResponse | ((init?: Parameters<Fetch>[1]) => FakeResponse)>,
  requests: Array<{ url: string; headers: Record<string, string> }> = [],
): Fetch {
  return async (url, init) => {
    requests.push({ url, headers: init?.headers ?? {} });
    const route = routes[url];
    const response: FakeResponse = route === undefined ? { status: 404, body: {} } : typeof route === "function" ? route(init) : route;
    const status = response.status ?? 200;
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => response.body,
      text: async () => response.text ?? JSON.stringify(response.body),
    };
  };
}
