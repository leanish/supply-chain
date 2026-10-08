// Copied from leanish/leanish-development core/runtime/src/skill/schema-subset.ts at e4f8a1e; see PROVENANCE.md.
import { EntrypointSchemaError } from "../errors.ts";

/**
 * The minimal structural JSON Schema subset the runtime accepts for an
 * Entry-point Skill's `inputSchema` / `outputSchema`. Per ADR-0004.
 *
 * Allowed keywords:
 *   - type — restricted to: object / array / string / number / integer / boolean
 *   - properties, required
 *   - additionalProperties — omitted, false, or a sub-schema
 *   - items
 *   - enum, const
 *   - minLength, maxLength
 *   - minimum, maximum
 *
 * Annotation keywords (allowed; ignored by validation):
 *   - description, title, examples
 *
 * Disallowed (reject at startup):
 *   - combinators (allOf / anyOf / oneOf / not)
 *   - references / metadata ($schema / $id / $ref / $defs / definitions)
 *   - other bounds (pattern / format / exclusiveMinimum / exclusiveMaximum / multipleOf)
 *   - type: "null"
 */
const ALLOWED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
]);

const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "description",
  "title",
  "examples",
]);

export function assertSubset(schema: unknown, entrypoint: string): void {
  walk(schema, "#", entrypoint);
}

function walk(schema: unknown, pointer: string, entrypoint: string): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new EntrypointSchemaError(
      entrypoint,
      `at '${pointer}': schema node must be an object`,
    );
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new EntrypointSchemaError(
        entrypoint,
        `at '${pointer}': '${key}' is not allowed in the runtime's schema subset`,
      );
    }
  }
  const obj = schema as Record<string, unknown>;

  // type
  if ("type" in obj) {
    const t = obj["type"];
    if (typeof t !== "string" || !ALLOWED_TYPES.has(t)) {
      throw new EntrypointSchemaError(
        entrypoint,
        `at '${pointer}/type': '${String(t)}' is not allowed (type: "null" or unions are not supported)`,
      );
    }
  }

  // annotation keywords (description / title / examples) are accepted via
  // ALLOWED_KEYWORDS above and ignored by validation — no descent needed.

  // properties
  if ("properties" in obj) {
    const props = obj["properties"];
    if (typeof props !== "object" || props === null || Array.isArray(props)) {
      throw new EntrypointSchemaError(
        entrypoint,
        `at '${pointer}/properties': must be an object`,
      );
    }
    for (const [name, sub] of Object.entries(props)) {
      walk(sub, `${pointer}/properties/${escapePointer(name)}`, entrypoint);
    }
  }

  // additionalProperties
  if ("additionalProperties" in obj) {
    const ap = obj["additionalProperties"];
    if (typeof ap === "boolean" || ap === undefined) {
      // ok
    } else if (typeof ap === "object" && ap !== null && !Array.isArray(ap)) {
      walk(ap, `${pointer}/additionalProperties`, entrypoint);
    } else {
      throw new EntrypointSchemaError(
        entrypoint,
        `at '${pointer}/additionalProperties': must be boolean or a sub-schema`,
      );
    }
  }

  // items
  if ("items" in obj) {
    walk(obj["items"], `${pointer}/items`, entrypoint);
  }

  // enum / const / required / bounds — accept without descent (terminal values)
}

function escapePointer(segment: string): string {
  // RFC 6901: encode '/' as '~1' and '~' as '~0'.
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
