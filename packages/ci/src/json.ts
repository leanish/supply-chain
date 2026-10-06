export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `record[field]` as a list of strings; absent is empty, anything else malformed fails. */
export function stringList(record: Record<string, unknown>, field: string, where: string): string[] {
  const value = record[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${where}: \`${field}\` must be a list of strings`);
  }
  return value as string[];
}

/** `record[field]` as a string; absent is undefined, anything else malformed fails. */
export function optionalString(record: Record<string, unknown>, field: string, where: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${where}: \`${field}\` must be a string`);
  return value;
}

export function dig(value: unknown, keys: ReadonlyArray<string>): unknown {
  return keys.reduce<unknown>((current, key) => (isObject(current) ? current[key] : undefined), value);
}
