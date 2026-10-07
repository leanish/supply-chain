/**
 * A tool's plan in its PR's body: a section for people (a heading, then the
 * tool's table) that ends with the plan itself as base64 JSON in a hidden
 * comment, so a later run or review tick reads back exactly what was planned.
 */
const BLOCK = /<!-- leanish:plan ([A-Za-z0-9+/=]+) -->/;

/** The hidden comment carrying `payload`. */
export function planBlock(payload: unknown): string {
  return `<!-- leanish:plan ${Buffer.from(JSON.stringify(payload)).toString("base64")} -->`;
}

/** The payload `body`'s hidden comment carries; undefined when there's none or it doesn't parse. */
export function planPayload(body: string): unknown {
  const found = BLOCK.exec(body);
  if (found === null) return undefined;
  try {
    return JSON.parse(Buffer.from(found[1]!, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `body` with its section (from `heading` through the hidden comment)
 * replaced by `section`, which must start with `heading` and end with its
 * block; appended when `body` has none.
 */
export function withPlanSection(body: string, heading: string, section: string): string {
  if (!section.startsWith(heading) || !BLOCK.test(section)) throw new Error(`a plan section starts with '${heading}' and carries its block`);
  const start = body.indexOf(heading);
  const block = BLOCK.exec(body);
  if (start === -1 || block === null || block.index < start) return `${body.trimEnd()}\n\n${section}`;
  return `${body.slice(0, start)}${section}${body.slice(block.index + block[0].length)}`;
}
