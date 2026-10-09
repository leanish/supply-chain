/** Change one declared spec without changing the manifest's formatting. */
import { formatManifest } from "./manifest-format.ts";

type Manifest = Record<string, unknown>;

export function withSpec(text: string, key: string, from: string, to: string, file: string): string {
  const manifest = JSON.parse(text) as Manifest;
  let found = false;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = manifest[field] as Record<string, string> | undefined;
    if (deps?.[key] === from) {
      deps[key] = to;
      found = true;
    }
  }
  if (!found) {
    throw new Error(`${file} doesn't declare ${key} as '${from}'`);
  }
  if (formatManifest(text, JSON.parse(text)) === text) {
    return formatManifest(text, manifest);
  }
  // Not npm's own formatting: replace the pair in place, when it's there exactly once.
  const pair = new RegExp(`${escape(JSON.stringify(key))}(\\s*:\\s*)${escape(JSON.stringify(from))}`, "g");
  const matches = [...text.matchAll(pair)];
  if (matches.length !== 1) {
    throw new Error(`${file} isn't formatted the way npm writes it, and '${key}: ${from}' isn't there exactly once to replace`);
  }
  return text.replace(pair, (_whole, colon: string) => `${JSON.stringify(key)}${colon}${JSON.stringify(to)}`);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
