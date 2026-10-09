// Copied from leanish/leanish-development core/runtime/src/skill/schema-subset.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: allow only the nullable-object union and a constant-property if/then requirement.
import { EntrypointSchemaError } from "../errors.ts";

/**
 * The minimal structural JSON Schema subset the runtime accepts for an
 * Entry-point Skill's `inputSchema` / `outputSchema`. Per ADR-0004.
 *
 * Allowed keywords:
 *   - type — object / array / string / number / integer / boolean, or [object, null]
 *   - if / then — one constant-property condition with a required non-null object
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
 *   - combinators (allOf / anyOf / oneOf / not), general conditionals
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
  "if",
  "then",
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
    const nullableObject = Array.isArray(t) && t.length === 2 && t[0] === "object" && t[1] === "null";
    if (!nullableObject && (typeof t !== "string" || !ALLOWED_TYPES.has(t))) {
      throw new EntrypointSchemaError(
        entrypoint,
        `at '${pointer}/type': '${String(t)}' is not allowed (only the [object, null] union is supported)`,
      );
    }
  }

  assertConditional(obj, pointer, entrypoint);

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

/** Keep the only conditional form bounded: when a discriminator equals a constant, require one object. */
function assertConditional(obj: Record<string, unknown>, pointer: string, entrypoint: string): void {
  if (!("if" in obj) && !("then" in obj)) return;
  const condition = obj["if"] as { properties?: Record<string, unknown> } | undefined;
  const consequent = obj["then"] as { required?: unknown; properties?: Record<string, unknown> } | undefined;
  const invalid = () => new EntrypointSchemaError(entrypoint, `at '${pointer}': only constant-property if/then with one required non-null object is supported`);
  if (condition === null || typeof condition !== "object" || Object.keys(condition).join() !== "properties") throw invalid();
  const properties = condition.properties;
  if (properties === undefined || properties === null || typeof properties !== "object" || Object.keys(properties).length !== 1) throw invalid();
  const test = Object.values(properties)[0];
  if (test === null || typeof test !== "object" || Object.keys(test).join() !== "const" || typeof (test as { const?: unknown }).const !== "string") throw invalid();
  if (consequent === null || typeof consequent !== "object" || Object.keys(consequent).some((key) => key !== "required" && key !== "properties")) throw invalid();
  const required = consequent.required;
  if (!Array.isArray(required) || required.length !== 1 || typeof required[0] !== "string") throw invalid();
  const fields = consequent.properties;
  if (fields === undefined || fields === null || typeof fields !== "object" || Object.keys(fields).length !== 1 || !(required[0] in fields)) throw invalid();
  const field = fields[required[0]] as { type?: unknown } | undefined;
  if (field === null || typeof field !== "object" || field.type !== "object") throw invalid();
  walk(condition, `${pointer}/if`, entrypoint);
  walk(consequent, `${pointer}/then`, entrypoint);
}
