// Copied from leanish/leanish-development core/runtime/test/unit/codex-model.test.ts at c6282df; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import {
  assertEffortSupported,
  isCodexModelFamily,
  parseCodexCatalog,
  resolveCodexModel,
} from "../src/skill/codex-model.ts";

const CATALOG = parseCodexCatalog(
  JSON.stringify({
    models: [
      { slug: "gpt-6.1-sol", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6-sol", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }] },
      { slug: "gpt-6.9-luna", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }] },
      { slug: "gpt-6.10-luna", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }] },
      { slug: "gpt-7-luna", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "gpt-5.5", visibility: "list", supported_reasoning_levels: ["medium"] },
      { display_name: "no slug" },
    ],
  }),
);

describe("isCodexModelFamily", () => {
  it("recognises the family names only", () => {
    expect(["sol", "astra", "luna"].map(isCodexModelFamily)).toEqual([true, true, true]);
    expect(isCodexModelFamily("gpt-6-luna")).toBe(false);
  });
});

describe("parseCodexCatalog", () => {
  it("keeps slug, visibility and efforts (object or string levels), skipping entries without a slug", () => {
    expect(CATALOG.map((model) => model.slug)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6.9-luna",
      "gpt-6.10-luna",
      "gpt-7-luna",
      "gpt-5.5",
    ]);
    expect(CATALOG.find((model) => model.slug === "gpt-5.5")?.supportedEfforts).toEqual(["medium"]);
  });

  it("rejects output that isn't a models catalog", () => {
    expect(() => parseCodexCatalog("not json")).toThrow(/not JSON/);
    expect(() => parseCodexCatalog('{"data": []}')).toThrow(/no `models` array/);
  });
});

describe("resolveCodexModel", () => {
  it("resolves a family to its newest listed version, comparing version parts as integers", () => {
    expect(resolveCodexModel("luna", CATALOG).slug).toBe("gpt-6.10-luna");
    expect(resolveCodexModel("sol", CATALOG).slug).toBe("gpt-6.1-sol");
  });

  it("ignores hidden models", () => {
    expect(resolveCodexModel("luna", CATALOG).slug).not.toBe("gpt-7-luna");
  });

  it("keeps a concrete model id, with the efforts the catalog lists for it", () => {
    expect(resolveCodexModel("gpt-6-sol", CATALOG)).toEqual({ slug: "gpt-6-sol", supportedEfforts: ["medium"] });
    expect(resolveCodexModel("gpt-unknown", CATALOG)).toEqual({ slug: "gpt-unknown", supportedEfforts: [] });
  });

  it("fails when the family has no listed model instead of falling back", () => {
    expect(() => resolveCodexModel("astra", CATALOG)).toThrow(/no listed gpt-<version>-astra model/);
  });
});

describe("assertEffortSupported", () => {
  it("accepts a listed effort, a missing effort, or an unknown effort list", () => {
    expect(() => assertEffortSupported(resolveCodexModel("luna", CATALOG), "xhigh")).not.toThrow();
    expect(() => assertEffortSupported(resolveCodexModel("luna", CATALOG), undefined)).not.toThrow();
    expect(() => assertEffortSupported(resolveCodexModel("gpt-unknown", CATALOG), "max")).not.toThrow();
  });

  it("rejects an effort the resolved model doesn't support", () => {
    expect(() => assertEffortSupported(resolveCodexModel("sol", CATALOG), "low")).toThrow(
      /effort 'low' is not supported by gpt-6.1-sol/,
    );
  });
});
