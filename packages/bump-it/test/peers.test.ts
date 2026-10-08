import { describe, expect, it, vi } from "vitest";

import type { NpmPeerPlanner, PeerAddition } from "../../ci/src/npm-peers.ts";
import { coupledUnit, constrainedPeers } from "../src/peers.ts";
import { majorUnits, routineUnit } from "../src/units.ts";
import { candidate } from "./fixtures.ts";

const UI = "@vitest/ui";
const lock = { lockfileVersion: 3, packages: {
  "": { devDependencies: { vitest: "^4.1.7", [UI]: "^4.1.7" } },
  "node_modules/vitest": { version: "4.1.7" },
  [`node_modules/${UI}`]: { version: "4.1.7", peerDependencies: { vitest: "4.1.7" } },
} };
const bump = candidate({ name: "vitest", from: "4.1.7", minor: { version: "4.1.11", line: "4" }, major: { version: "5.0.0", line: "5" },
  declarations: [{ lockfile: "package-lock.json", workspace: ".", declaredAs: "vitest", spec: "^4.1.7" }] });
const addition: PeerAddition = { name: UI, from: "4.1.7", to: "4.1.11", line: "4", aged: true, locations: [`node_modules/${UI}`],
  declarations: [{ lockfile: "package-lock.json", path: `node_modules/${UI}`, name: UI, version: "4.1.7", workspace: "", declaredAs: UI, spec: "^4.1.7" }] };

describe("bump direct peers", () => {
  it("passes physical copies to the planner and includes companions in routine and major manifests", async () => {
    const peers: NpmPeerPlanner = { resolve: vi.fn(async () => ({ additions: [addition], blocked: [], sets: [["vitest", UI]] })) };
    const result = await coupledUnit(routineUnit([bump]), new Map([["package-lock.json", lock]]), peers);
    expect(peers.resolve).toHaveBeenCalledWith([{ name: "vitest", from: "4.1.7", to: "4.1.11", locations: ["node_modules/vitest"] }]);
    expect(result.unit.moves.map((move) => [move.name, move.to])).toEqual([["vitest", "4.1.11"], [UI, "4.1.11"]]);
    expect(result.unit.moves[1]?.declarations).toEqual([{ lockfile: "package-lock.json", workspace: ".", declaredAs: UI, spec: "^4.1.7" }]);
    const major = await coupledUnit(majorUnits([bump])[0]!, new Map([["package-lock.json", lock]]), peers);
    expect(major.unit).toMatchObject({ kind: "major", package: "npm|vitest", topic: "vitest-major" });
    expect(major.unit.moves[1]?.major).toBe(false);
  });

  it("reports a blocked peer set while keeping an unrelated routine move", async () => {
    const peers: NpmPeerPlanner = { resolve: async (moves) => ({ additions: [], blocked: [{ moves: moves.filter((move) => move.name === "vitest"), reason: "UI has no aged compatible version" }], sets: [] }) };
    const other = candidate({ ecosystem: "Maven", name: "g:other", declarations: [] });
    const result = await coupledUnit(routineUnit([bump, other]), new Map([["package-lock.json", lock]]), peers);
    expect(result.unit.moves.map((move) => move.name)).toEqual(["g:other"]);
    expect(result.notes).toEqual(["UI has no aged compatible version"]);
  });

  it("drops the entire set when a repository constraint removes a companion declaration, even if another copy stays", async () => {
    const peers: NpmPeerPlanner = { resolve: async () => ({ additions: [addition], blocked: [], sets: [["vitest", UI]] }) };
    const coupled = await coupledUnit(routineUnit([bump]), new Map([["package-lock.json", lock]]), peers);
    const other = routineUnit([candidate({ ecosystem: "Maven", name: "g:other", declarations: [] })]).moves[0]!;
    const before = { ...coupled.unit, moves: [...coupled.unit.moves, { ...coupled.unit.moves[1]!, declarations: [{ ...addition.declarations[0]!, workspace: "client" }] }, other] };
    const after = { ...before, moves: before.moves.filter((move) => move.declarations[0]?.workspace !== "." || move.name !== UI) };
    const result = constrainedPeers(before, after, coupled.sets);
    expect(result.unit.moves.map((move) => move.name)).toEqual(["g:other"]);
    expect(result.notes).toContain("vitest: its direct-peer set is blocked by a repository constraint");
  });
});
