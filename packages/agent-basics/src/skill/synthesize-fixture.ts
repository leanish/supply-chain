// Copied from leanish/leanish-development core/runtime/src/skill/synthesize-fixture.ts at e4f8a1e; see PROVENANCE.md.
/**
 * Walk an entry-point skill's `outputSchema` (in the ADR-0004 minimal
 * structural subset) and produce a minimum value that satisfies it. Used
 * by the local-mode `FakeCodingAgentRunner` default responder so the
 * `atc-dev-publish | run-local --fake-runner` smoke works end-to-end
 * without registering per-entrypoint fixture data.
 *
 * Rules:
 *   - `type: "string"` → `"<placeholder>"` (or honour `minLength`).
 *   - `type: "number" | "integer"` → `0` (or `minimum` if `> 0`).
 *   - `type: "boolean"` → `false`.
 *   - `type: "array"` → `[]`.
 *   - `type: "object"` → recursively fill `required` properties.
 *   - `const` / `enum` → first allowed value.
 *
 * This is intentionally minimum-shape, not realistic. Tests that need
 * realistic responses should register an explicit `FakeResponse`.
 */
export function synthesizeFixture(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return null;
  }
  const s = schema as Record<string, unknown>;

  if ("const" in s) return s["const"];
  if (Array.isArray(s["enum"])) {
    const first = s["enum"][0];
    return first === undefined ? null : first;
  }

  const type = s["type"];
  switch (type) {
    case "string":
      return placeholderString(typeof s["minLength"] === "number" ? s["minLength"] : 0);
    case "number":
    case "integer":
      return typeof s["minimum"] === "number" && s["minimum"] > 0 ? s["minimum"] : 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object": {
      const required = Array.isArray(s["required"]) ? (s["required"] as string[]) : [];
      const properties =
        typeof s["properties"] === "object" && s["properties"] !== null
          ? (s["properties"] as Record<string, unknown>)
          : {};
      const out: Record<string, unknown> = {};
      for (const key of required) {
        out[key] = synthesizeFixture(properties[key]);
      }
      return out;
    }
    default:
      return null;
  }
}

function placeholderString(minLength: number): string {
  const base = "fake-fixture";
  if (base.length >= minLength) return base;
  return base + "x".repeat(minLength - base.length);
}
