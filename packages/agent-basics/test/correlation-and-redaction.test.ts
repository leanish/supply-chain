// Copied from leanish/leanish-development core/runtime/test/unit/correlation-and-redaction.test.ts at c6282df; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "../src/logger/console-logger.ts";
import { withCorrelation } from "../src/logger/correlation.ts";
import { Redactor } from "../src/logger/redactor.ts";

function capture(stream: PassThrough): () => string {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
  });
  return () => buf;
}

describe("logger correlation", () => {
  it("merges async-local correlation into emitted lines", async () => {
    const stream = new PassThrough();
    const read = capture(stream);
    const logger = new ConsoleLogger({ stream, minLevel: "debug" });
    await withCorrelation({ requestId: "req-1", stage: "init" }, async () => {
      logger.info("hello");
    });
    expect(read()).toContain('"requestId":"req-1"');
    expect(read()).toContain('"stage":"init"');
  });

  it("does not leak correlation outside the run", () => {
    const stream = new PassThrough();
    const read = capture(stream);
    const logger = new ConsoleLogger({ stream, minLevel: "debug" });
    logger.info("outside");
    expect(read()).not.toContain('"requestId"');
  });
});

describe("logger redaction", () => {
  it("substring-replaces known secret values with <redacted:NAME>", () => {
    const stream = new PassThrough();
    const read = capture(stream);
    const redactor = new Redactor([{ name: "GITHUB_TOKEN", value: "ghp_supersecret" }]);
    const logger = new ConsoleLogger({ stream, minLevel: "debug", redactor });
    logger.info("call failed", { url: "https://api.github.com/...", auth: "Bearer ghp_supersecret" });
    expect(read()).toContain("<redacted:GITHUB_TOKEN>");
    expect(read()).not.toContain("ghp_supersecret");
  });

  it("is a no-op when no secrets are configured", () => {
    const stream = new PassThrough();
    const read = capture(stream);
    const logger = new ConsoleLogger({ stream, minLevel: "debug" });
    logger.info("ok", { value: "plain" });
    expect(read()).toContain("plain");
  });
});
