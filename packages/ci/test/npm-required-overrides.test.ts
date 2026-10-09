import { describe, expect, it } from "vitest";

import { overrideConstraints } from "../src/npm-required-overrides.ts";

const packages = { "node_modules/parent": { version: "1.0.0" }, "node_modules/parent/node_modules/lib": { version: "2.0.0" } };
const path = "node_modules/parent/node_modules/lib";

describe("baseline override constraints", () => {
  it("includes plain, version-qualified and nested object-form rules without dropping child rules", () => {
    expect(overrideConstraints({ overrides: { lib: ">=2", "parent@^1": { lib: { ".": "<3", child: "1.0.0" } } } }, packages, path, "lib")).toEqual([">=2", "<3"]);
  });

  it("resolves declaration references and rejects unreadable ones", () => {
    const manifest = { dependencies: { library: "npm:lib@^2" } };
    expect(overrideConstraints({ manifest, overrides: { lib: "$library" } }, packages, path, "lib")).toEqual(["^2"]);
    expect(() => overrideConstraints({ manifest, overrides: { lib: "$absent" } }, packages, path, "lib")).toThrow("unresolved override reference");
  });

  it("does not apply unrelated ancestors' pins", () => {
    expect(overrideConstraints({ overrides: { "parent@^2": { lib: "2.1.0" }, other: "1.0.0" } }, packages, path, "lib")).toEqual([]);
  });
});
