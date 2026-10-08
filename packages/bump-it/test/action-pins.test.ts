import { describe, expect, it } from "vitest";
import type { Tree } from "../../ci/src/tree.ts";
import { plannedPinsLanded } from "../src/action-pins.ts";
import type { PlannedMove } from "../src/plan.ts";
const file = ".github/workflows/ci.yml";
const tree = (text: string): Tree => ({ id: "tree", read: async (path) => path === file ? text : undefined, list: async (dir) => file.startsWith(`${dir}/`) ? [file] : [] });
const workflow = (uses: ReadonlyArray<[string, string]>) => `on: push\njobs:\n  build:\n    steps:\n${uses.map(([sha, tag]) => `      - uses: actions/checkout@${sha.repeat(40)} # ${tag}`).join("\n")}\n`;
const move = (from: string, to: string, sha: string): PlannedMove => ({ ecosystem: "GitHub Actions", mechanism: "action-pin", name: "actions/checkout", from, to, commitSha: sha.repeat(40), locations: [file], declarations: [], major: false });
describe("action source versions", () => {
  it("lands two lines of an action in one workflow at their separate targets", async () => {
    expect(await plannedPinsLanded([move("v1.0.0", "v1.1.0", "a"), move("v2.0.0", "v2.1.0", "b")], tree(workflow([["0", "v1.0.0"], ["1", "v2.0.0"]])), tree(workflow([["a", "v1.1.0"], ["b", "v2.1.0"]])))).toEqual([]);
  });
  it("keeps an unplanned version of a planned action at base, even in the same file", async () => {
    const before = tree(workflow([["0", "v1.0.0"], ["1", "v2.0.0"]]));
    const planned = [move("v1.0.0", "v1.1.0", "a")];
    expect(await plannedPinsLanded(planned, before, tree(workflow([["a", "v1.1.0"], ["1", "v2.0.0"]])))).toEqual([]);
    expect(await plannedPinsLanded(planned, before, tree(workflow([["a", "v1.1.0"], ["b", "v2.1.0"]])))).toContain(`${file}: actions/checkout at v2.0.0 changed outside its planned source version`);
  });
});
