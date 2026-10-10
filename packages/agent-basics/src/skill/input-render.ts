// Copied from leanish/leanish-development core/runtime/src/skill/input-render.ts at c6282df; see PROVENANCE.md.
import { stringify as stringifyYaml } from "yaml";

/**
 * Render a typed `input` object as YAML for `$ARGUMENTS`, following the
 * deterministic conventions from ADR-0004 §Input rendering:
 *
 *   - Keys emitted verbatim in their declared camelCase form.
 *   - Key order follows `inputSchema.properties` declaration order.
 *   - Scalars inline next to their key.
 *   - Objects / arrays as YAML block style (newline + 2-space indent).
 *   - Optional fields whose value is `undefined` / `null` are omitted.
 *
 * Determinism matters for prompt caching (same input ⇒ identical prompt
 * prefix) and for snapshot tests.
 */
export function renderInput(input: unknown, inputSchema: unknown): string {
  const ordered = reorder(input, inputSchema);
  return stringifyYaml(ordered, {
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    blockQuote: "literal",
    lineWidth: 0, // never wrap; long strings stay on one logical line
  }).replace(/\n$/, "");
}

/**
 * Recursively reorder object keys to match the schema's `properties` order.
 * Drops `undefined` / `null` values (per ADR-0004 — absence from `required`
 * is the source of truth for optionality).
 */
function reorder(value: unknown, schema: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const itemsSchema = isObject(schema) ? schema["items"] : undefined;
    return value
      .map((item) => reorder(item, itemsSchema))
      .filter((v) => v !== undefined);
  }
  if (isObject(value)) {
    const props = isObject(schema) ? schema["properties"] : undefined;
    const out: Record<string, unknown> = {};
    if (isObject(props)) {
      for (const key of Object.keys(props)) {
        if (!(key in value)) continue;
        const next = reorder(value[key], props[key]);
        if (next !== undefined) out[key] = next;
      }
      // Trailing keys not in `properties` (when `additionalProperties` was
      // omitted or a sub-schema): emit in insertion order after declared ones.
      for (const key of Object.keys(value)) {
        if (key in props) continue;
        const next = reorder(value[key], undefined);
        if (next !== undefined) out[key] = next;
      }
    } else {
      for (const key of Object.keys(value)) {
        const next = reorder(value[key], undefined);
        if (next !== undefined) out[key] = next;
      }
    }
    return out;
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
