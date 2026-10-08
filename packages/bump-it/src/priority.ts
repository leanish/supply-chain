/** Deferred new majors go first next run, even when earlier majors remain blocked. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MajorPriority {
  read(): Promise<ReadonlyArray<string>>;
  write(packages: ReadonlyArray<string>): Promise<void>;
}

export function filePriority(stateDir: string, repo: string): MajorPriority {
  const path = join(stateDir, "deferred", `${repo.toLowerCase().replace("/", "__")}.json`);
  return {
    async read() {
      try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!Array.isArray(value) || !value.every((key) => typeof key === "string")) {
          throw new Error(`${path} is not a deferred-major list`);
        }
        return value;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw err;
      }
    },
    async write(packages) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, `${JSON.stringify([...new Set(packages)])}\n`);
      await rename(`${path}.tmp`, path);
    },
  };
}
