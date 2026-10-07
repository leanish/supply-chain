/** Serialize a manifest with its existing indentation, line endings and final newline. */
export function formatManifest(original: string, manifest: unknown): string {
  const indent = /^[ \t]+(?=")/m.exec(original)?.[0];
  const multiline = original.trimEnd().includes("\n");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const spacing = indent ?? (multiline ? "  " : undefined);
  const text = JSON.stringify(manifest, null, spacing).replaceAll("\n", newline);
  return `${text}${original.endsWith(newline) ? newline : ""}`;
}
