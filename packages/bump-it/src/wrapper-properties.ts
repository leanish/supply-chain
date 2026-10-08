/** Read Java properties without interpreting an escaped URL or duplicate key differently from Gradle. */
export function wrapperProperties(text: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!.trimStart();
    if (line === "" || /^[#!]/.test(line)) continue;
    while (continued(line)) {
      if (++index >= lines.length) throw new Error("unfinished wrapper property continuation");
      line = line.slice(0, -1) + lines[index]!.trimStart();
    }
    const match = /^((?:\\.|[^\\=:\s])*)(?:\s*[=:]\s*|\s+)?(.*)$/.exec(line)!;
    const key = unescapeProperty(match[1]!);
    if (properties.has(key)) throw new Error(`duplicate wrapper property ${key}`);
    properties.set(key, unescapeProperty(match[2]!));
  }
  return properties;
}

function continued(line: string): boolean {
  return (/(\\+)$/.exec(line)?.[1]?.length ?? 0) % 2 === 1;
}

function unescapeProperty(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escaped: string) => {
    if (escaped.startsWith("u")) {
      if (!/^u[0-9a-fA-F]{4}$/.test(escaped)) throw new Error("invalid wrapper property unicode escape");
      return String.fromCharCode(parseInt(escaped.slice(1), 16));
    }
    return ({ t: "\t", n: "\n", r: "\r", f: "\f" } as Record<string, string>)[escaped] ?? escaped;
  });
}
