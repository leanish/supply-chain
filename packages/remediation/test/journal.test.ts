import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileJournal } from "../src/journal.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "journal-"));
});

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe("FileJournal", () => {
  it("keeps the last push per PR, per repository, across instances", async () => {
    const head = "c".repeat(40);
    const base = "e".repeat(40);
    await new FileJournal(dir).pushed("Leanish/Widget", 7, { head: "a".repeat(40), base });
    await new FileJournal(dir).pushed("leanish/widget", 7, { head, base });
    await new FileJournal(dir).pushed("leanish/widget", 8, { head: base, base: head });
    const journal = new FileJournal(dir);
    expect(await journal.last("leanish/widget", 7)).toEqual({ head, base });
    expect(await journal.last("leanish/widget", 9)).toBeUndefined();
    expect(await journal.last("leanish/other", 7)).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "journal", "leanish__widget.json"), "utf8"))).toEqual({ "7": { head, base }, "8": { head: base, base: head } });
  });

  it("fails on a file that isn't a journal rather than reading it as empty", async () => {
    await mkdir(join(dir, "journal"), { recursive: true });
    await writeFile(join(dir, "journal", "leanish__broken.json"), "[]");
    await expect(new FileJournal(dir).last("leanish/broken", 1)).rejects.toThrow("isn't a journal");
  });

  it("persists the complete publication for recovery after a body update fails", async () => {
    const state = { head: "c".repeat(40), base: "e".repeat(40), publication: { title: "new plan", body: "plan and state markers", adaptations: 1 } };
    await new FileJournal(dir).pushed("leanish/content", 7, state);
    expect(await new FileJournal(dir).last("leanish/content", 7)).toEqual(state);
  });
});
