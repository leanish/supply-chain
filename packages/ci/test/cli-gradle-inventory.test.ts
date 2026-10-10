import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.ts";

afterEach(() => vi.restoreAllMocks());

describe("gradle-inventory's transform options", () => {
  it.each([
    [["--init-script", "reference.init.gradle"]],
    [["--define", "supplyChain.reference.file=plan.json"]],
    [["--init-script", "reference.init.gradle", "--define", "no-equals"]],
  ])("takes --init-script and --define <key>=<value> only together: %j", async (args) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["gradle-inventory", "--out", "inventory.json", "--repo", "/nonexistent", "--head", "worktree", ...args])).toBe(2);
    expect(errors).toHaveBeenCalledWith("✗ gradle-inventory takes --init-script and --define <key>=<value> together");
  });
});
