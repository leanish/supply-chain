import { afterEach, describe, expect, it, vi } from "vitest";

import { type Fetch, mapLimited, namingFailures, type RetryTiming } from "../src/http.ts";

const URL = "https://repo1.maven.org/maven2/acme/lib/1.0/lib-1.0.pom";

function connectionError(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connection failed"), { code }) });
}

function timing(random = 0.5): RetryTiming & { sleep: ReturnType<typeof vi.fn> } {
  return { sleep: vi.fn(async () => {}), random: () => random };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

afterEach(() => vi.useRealTimers());

describe("named HTTP reads", () => {
  it.each(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT"])(
    "retries %s twice, with exponential backoff, then returns the complete read",
    async (code) => {
      const clock = timing();
      const fetch = vi.fn<Fetch>()
        .mockRejectedValueOnce(connectionError(code))
        .mockRejectedValueOnce(connectionError(code))
        .mockResolvedValueOnce(new Response('{"found":true}', { headers: { "x-result": "complete" } }));

      const response = await namingFailures(fetch, clock)(URL);

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(clock.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([500, 1000]);
      expect(response.status).toBe(200);
      expect(response.ok).toBe(true);
      expect(response.headers.get("x-result")).toBe("complete");
      expect(await response.text()).toBe('{"found":true}');
      expect(await response.json()).toEqual({ found: true });
    },
  );

  it.each(["HEAD", "get"])("retries %s while preserving the request fields", async (method) => {
    const fetch = vi.fn<Fetch>().mockRejectedValueOnce(connectionError("ECONNRESET")).mockResolvedValueOnce(new Response(""));
    const init = { method, headers: { accept: "application/json" }, signal: new AbortController().signal };

    await namingFailures(fetch, timing())(URL, init);

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, request] of fetch.mock.calls) {
      expect(request).toBe(init);
      expect(request?.signal).toBe(init.signal);
    }
  });

  it.each([{ random: 0, delays: [250, 500] }, { random: 1, delays: [750, 1500] }])(
    "bounds jitter for random=$random",
    async ({ random, delays }) => {
      const clock = timing(random);
      const fetch = vi.fn<Fetch>().mockRejectedValue(connectionError("ECONNRESET"));

      await expect(namingFailures(fetch, clock)(URL)).rejects.toThrow("ECONNRESET");

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(clock.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual(delays);
    },
  );

  it("exhausts retries with the final error, URL and cause", async () => {
    const final = connectionError("UND_ERR_CONNECT_TIMEOUT");
    const fetch = vi.fn<Fetch>().mockRejectedValueOnce(connectionError("ECONNRESET")).mockRejectedValue(final);
    const failed = namingFailures(fetch, timing())(URL);

    await expect(failed).rejects.toThrow(`GET ${URL} failed: UND_ERR_CONNECT_TIMEOUT connection failed`);
    await expect(failed).rejects.toMatchObject({ cause: final });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries a reset during the body, using the replacement response's status and headers", async () => {
    const clock = timing();
    const broken = new Response("truncated");
    vi.spyOn(broken, "text").mockRejectedValue(connectionError("UND_ERR_SOCKET"));
    const fetch = vi.fn<Fetch>().mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(new Response('{"complete":true}', { status: 201, headers: { "x-attempt": "second" } }));

    const response = await namingFailures(fetch, clock)(URL);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-attempt")).toBe("second");
    expect(await response.json()).toEqual({ complete: true });
    expect(clock.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([500]);
  });

  it("names body reset failures after exhausting all complete-read attempts", async () => {
    const fetch = vi.fn<Fetch>(async () => {
      const response = new Response("truncated");
      vi.spyOn(response, "text").mockRejectedValue(connectionError("ECONNRESET"));
      return response;
    });

    await expect(namingFailures(fetch, timing())(URL)).rejects.toThrow(`GET ${URL} failed: ECONNRESET connection failed`);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry malformed JSON after a successful read", async () => {
    const clock = timing();
    const fetch = vi.fn<Fetch>().mockResolvedValue(new Response("{broken"));
    const response = await namingFailures(fetch, clock)(URL);

    await expect(response.json()).rejects.toBeInstanceOf(SyntaxError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it.each([404, 429, 503])("leaves HTTP %s untouched, without reading or retrying its body", async (status) => {
    const clock = timing();
    const original = new Response("error", { status });
    const text = vi.spyOn(original, "text").mockRejectedValue(connectionError("ECONNRESET"));
    const fetch = vi.fn<Fetch>().mockResolvedValue(original);

    expect(await namingFailures(fetch, clock)(URL)).toBe(original);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])("never retries a %s request", async (method) => {
    const clock = timing();
    const fetch = vi.fn<Fetch>().mockRejectedValue(connectionError("ECONNRESET"));
    const init = { method, body: '{"state":"failure"}' };

    await expect(namingFailures(fetch, clock)(URL, init)).rejects.toThrow(`${method} ${URL} failed: ECONNRESET`);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(URL, init);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("leaves successful writes and their body handling unchanged", async () => {
    const original = new Response('{"published":true}');
    const text = vi.spyOn(original, "text");
    const fetch = vi.fn<Fetch>().mockResolvedValue(original);

    const response = await namingFailures(fetch, timing())(URL, { method: "POST" });

    expect(response).toBe(original);
    expect(text).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ published: true });
  });

  it.each(["ENOTFOUND", "CERT_HAS_EXPIRED", "UND_ERR_INVALID_ARG"])("does not retry %s", async (code) => {
    const clock = timing();
    const fetch = vi.fn<Fetch>().mockRejectedValue(connectionError(code));

    await expect(namingFailures(fetch, clock)(URL)).rejects.toThrow(code);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("does not classify error-message substrings as transient codes", async () => {
    const fetch = vi.fn<Fetch>().mockRejectedValue(new Error("invalid document mentions ECONNRESET"));

    await expect(namingFailures(fetch, timing())(URL)).rejects.toThrow("invalid document");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("recognises nested error codes without looping over circular causes", async () => {
    const failure = connectionError("ECONNRESET");
    Object.assign(failure.cause as Error, { cause: failure });
    const fetch = vi.fn<Fetch>().mockRejectedValueOnce(new Error("wrapper", { cause: failure })).mockResolvedValueOnce(new Response("ok"));

    expect(await (await namingFailures(fetch, timing())(URL)).text()).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry an abort even if its cause carries a transient code", async () => {
    const aborted = Object.assign(new Error("cancelled", { cause: connectionError("ECONNRESET") }), { name: "AbortError" });
    const fetch = vi.fn<Fetch>().mockRejectedValue(aborted);

    await expect(namingFailures(fetch, timing())(URL)).rejects.toMatchObject({ cause: aborted });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not start a request when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const fetch = vi.fn<Fetch>();

    await expect(namingFailures(fetch, timing())(URL, { signal: controller.signal })).rejects.toThrow("caller cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry after the caller aborts during backoff", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<Fetch>().mockRejectedValue(connectionError("ECONNRESET"));
    const clock = { random: () => 0.5, sleep: async () => controller.abort(new Error("caller cancelled")) };

    await expect(namingFailures(fetch, clock)(URL, { signal: controller.signal })).rejects.toThrow("caller cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["headers", "body"])("honours caller cancellation while reading %s", async (phase) => {
    const controller = new AbortController();
    const started = deferred<void>();
    const clock = timing();
    const reason = new Error("caller cancelled");
    const fetch = vi.fn<Fetch>(async (_url, init) => {
      const pending = untilAborted(init!.signal!);
      started.resolve();
      if (phase === "headers") return pending;
      const response = new Response("pending");
      vi.spyOn(response, "text").mockImplementation(() => pending);
      return response;
    });
    const failed = namingFailures(fetch, clock)(URL, { signal: controller.signal });
    const checked = expect(failed).rejects.toMatchObject({ cause: reason });

    await started.promise;
    controller.abort(reason);
    await checked;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"])("allows a slow successful %s read without an overall timeout", async (phase) => {
    vi.useFakeTimers();
    const headers = deferred<Awaited<ReturnType<Fetch>>>();
    const body = deferred<string>();
    const original = new Response("pending");
    vi.spyOn(original, "text").mockImplementation(() => body.promise);
    const fetch = vi.fn<Fetch>(() => phase === "headers" ? headers.promise : Promise.resolve(original));
    let settled = false;
    const result = namingFailures(fetch, timing())(URL);
    const checked = result.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(settled).toBe(false);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(URL, undefined);
    expect(vi.getTimerCount()).toBe(0);
    headers.resolve(original);
    body.resolve("complete");
    expect(await (await checked).text()).toBe("complete");
  });

  it("does not install an overall timeout after a successful read", async () => {
    vi.useFakeTimers();
    await namingFailures(async () => new Response("ok"), timing())(URL);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows bounded retries when attempts and backoff take more than 35 seconds", async () => {
    vi.useFakeTimers();
    const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    const clock = { sleep: vi.fn(wait), random: () => 0.5 };
    const timeout = async () => {
      await wait(20_000);
      throw connectionError("UND_ERR_CONNECT_TIMEOUT");
    };
    const fetch = vi.fn<Fetch>().mockImplementationOnce(timeout).mockImplementationOnce(timeout)
      .mockResolvedValueOnce(new Response("complete"));
    const result = namingFailures(fetch, clock)(URL);

    await vi.advanceTimersByTimeAsync(41_500);

    expect(await (await result).text()).toBe("complete");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(clock.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([500, 1000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interrupts pending backoff when the caller cancels", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const clock = {
      random: () => 0.5,
      sleep: vi.fn((_milliseconds: number, signal?: AbortSignal) => {
        started.resolve();
        return untilAborted(signal!);
      }),
    };
    const fetch = vi.fn<Fetch>().mockRejectedValue(connectionError("ECONNRESET"));
    const failed = namingFailures(fetch, clock)(URL, { signal: controller.signal });
    const checked = expect(failed).rejects.toThrow("caller cancelled");

    await started.promise;
    controller.abort(new Error("caller cancelled"));
    await checked;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(clock.sleep).toHaveBeenCalledExactlyOnceWith(500, controller.signal);
  });
});

describe("limited work", () => {
  it("bounds concurrency and retains input order despite reversed completion", async () => {
    const pending = [deferred<string>(), deferred<string>(), deferred<string>()];
    let active = 0;
    let peak = 0;
    const work = vi.fn(async (index: number) => {
      peak = Math.max(peak, ++active);
      const value = await pending[index]!.promise;
      active--;
      return value;
    });
    const result = mapLimited([0, 1, 2], 2, work);
    expect(work.mock.calls).toEqual([[0], [1]]);

    pending[1]!.resolve("second");
    await pending[1]!.promise;
    await Promise.resolve();
    expect(work.mock.calls).toEqual([[0], [1], [2]]);
    pending[2]!.resolve("third");
    pending[0]!.resolve("first");

    expect(await result).toEqual(["first", "second", "third"]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("stops scheduling and waits for active work after the first failure", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const failure = new Error("first failure");
    const work = vi.fn((index: number) => index === 0 ? first.promise : second.promise);
    let settled = false;
    const result = mapLimited([0, 1, 2, 3], 2, work);
    const checked = result.then(() => { settled = true; }, (error) => { settled = true; return error; });

    first.reject(failure);
    await first.promise.catch(() => {});
    expect(settled).toBe(false);
    expect(work.mock.calls).toEqual([[0], [1]]);
    second.resolve("finished");

    expect(await checked).toBe(failure);
    expect(settled).toBe(true);
    expect(work.mock.calls).toEqual([[0], [1]]);
  });

  it("preserves the first observed failure when another active task fails", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const failure = new Error("second failed first");
    const result = mapLimited([0, 1, 2], 2, (index) => index === 0 ? first.promise : second.promise);
    const checked = result.catch((error: unknown) => error);

    second.reject(failure);
    await second.promise.catch(() => {});
    first.reject(new Error("first failed later"));

    expect(await checked).toBe(failure);
  });

  it("preserves undefined as a thrown failure", async () => {
    const work = vi.fn(async () => { throw undefined; });
    const result = await mapLimited([0, 1], 1, work).then(() => "success", (error: unknown) => ({ error }));

    expect(result).toEqual({ error: undefined });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("stops on a synchronous throw before starting another worker", async () => {
    const failure = new Error("synchronous failure");
    const work = vi.fn((): Promise<string> => { throw failure; });

    await expect(mapLimited([0, 1], 2, work)).rejects.toBe(failure);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result without starting work", async () => {
    const work = vi.fn(async () => "unused");
    expect(await mapLimited([], 3, work)).toEqual([]);
    expect(work).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid concurrency %s", async (limit) => {
    await expect(mapLimited([1], limit, async (value) => value)).rejects.toThrow("positive integer limit");
  });
});
