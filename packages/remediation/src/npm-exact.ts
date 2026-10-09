/** Resolve simultaneous exact declarations, restore planned bytes even on failure, then check the restored install. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { formatManifest } from "./manifest-format.ts";
import { writeLocalFile } from "./local-files.ts";

export async function resolveExact(
  root: string,
  planned: ReadonlyMap<string, string>,
  pinned: ReadonlyMap<string, Record<string, unknown>>,
  resolve: () => Promise<void>,
  install: () => Promise<void>,
): Promise<void> {
  const temporary = new Map(planned);
  for (const [owner, manifest] of pinned) {
    const original = planned.get(owner);
    if (original === undefined) throw new Error(`no planned manifest for ${owner || "the root"}`);
    temporary.set(owner, formatManifest(original, manifest));
  }
  try {
    await writeManifests(root, temporary);
    await resolve();
    await assertManifests(root, temporary);
  } finally {
    await writeManifests(root, planned);
  }
  await install();
  await assertManifests(root, planned);
}

async function writeManifests(root: string, texts: ReadonlyMap<string, string>): Promise<void> {
  for (const [owner, text] of texts) await writeLocalFile(root, manifestPath(owner), text);
}

async function assertManifests(root: string, texts: ReadonlyMap<string, string>): Promise<void> {
  for (const [owner, text] of texts) {
    const path = manifestPath(owner);
    if (await readFile(join(root, path), "utf8") !== text) throw new Error(`npm rewrote ${path}; only planned manifest edits may land`);
  }
}

export function manifestPath(owner: string): string {
  return owner === "" ? "package.json" : `${owner}/package.json`;
}
