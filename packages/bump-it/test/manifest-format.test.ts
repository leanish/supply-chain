import { describe, expect, it } from "vitest";

import { formatManifest } from "../src/manifest-format.ts";

describe("manifest formatting", () => {
  it.each([
    ["four spaces, LF and final newline", "    ", "\n", true],
    ["tabs, CRLF and final newline", "\t", "\r\n", true],
    ["two spaces, CRLF and no final newline", "  ", "\r\n", false],
    ["compact JSON with a final newline", undefined, "\n", true],
    ["compact JSON without a final newline", undefined, "\n", false],
  ] as const)("keeps %s while changing a dependency", (_name, indent, newline, finalNewline) => {
    const serialize = (version: string) => JSON.stringify({ name: "widget", dependencies: { lib: version } }, null, indent)
      .replaceAll("\n", newline) + (finalNewline ? newline : "");
    expect(formatManifest(serialize("^1.0.0"), { name: "widget", dependencies: { lib: "^2.0.0" } }))
      .toBe(serialize("^2.0.0"));
  });
});
