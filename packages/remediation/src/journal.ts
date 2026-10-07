/**
 * The tool's own record of what it pushed to each PR, written right after a
 * push and before the PR's body is updated to say so. If that update fails,
 * the PR's head is the tool's commit but its body still names the previous
 * one; the review tick then finds the exact head here, repairs the body, and
 * carries on, instead of reading its own push as someone else's. Only an exact
 * match counts: any other head is still someone else's push.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PushedState {
  readonly head: string;
  readonly base: string;
}

export interface PublicationJournal {
  /** Records that the tool pushed `state.head`, computed against `state.base`, to `repo`'s PR `number`. */
  pushed(repo: string, number: number, state: PushedState): Promise<void>;
  /** What the tool last recorded pushing to that PR. */
  last(repo: string, number: number): Promise<PushedState | undefined>;
}

/** One JSON file per repository under the tool's state directory: `journal/<owner>__<repo>.json`. */
export class FileJournal implements PublicationJournal {
  readonly #dir: string;

  constructor(stateDir: string) {
    this.#dir = join(stateDir, "journal");
  }

  async pushed(repo: string, number: number, state: PushedState): Promise<void> {
    const file = this.#file(repo);
    const entries = await this.#read(file);
    entries[String(number)] = { head: state.head, base: state.base };
    await mkdir(dirname(file), { recursive: true });
    // Written whole and renamed into place: a crash leaves the old record, never half of one.
    await writeFile(`${file}.tmp`, `${JSON.stringify(entries, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
  }

  async last(repo: string, number: number): Promise<PushedState | undefined> {
    return (await this.#read(this.#file(repo)))[String(number)];
  }

  #file(repo: string): string {
    return join(this.#dir, `${repo.toLowerCase().replace("/", "__")}.json`);
  }

  async #read(file: string): Promise<Record<string, PushedState>> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file} isn't a journal`);
    return parsed as Record<string, PushedState>;
  }
}

/** A journal in memory, for tests. */
export class MemoryJournal implements PublicationJournal {
  readonly entries = new Map<string, PushedState>();

  async pushed(repo: string, number: number, state: PushedState): Promise<void> {
    this.entries.set(`${repo.toLowerCase()}#${number}`, state);
  }

  async last(repo: string, number: number): Promise<PushedState | undefined> {
    return this.entries.get(`${repo.toLowerCase()}#${number}`);
  }
}
