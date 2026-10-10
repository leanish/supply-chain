// Copied from leanish/leanish-development core/runtime/src/skill/validator.ts at c6282df; see PROVENANCE.md.
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import type { SchemaErrorItem } from "../errors.ts";

/**
 * Thin Ajv wrapper. Caches compiled validators per schema reference, and
 * normalises Ajv's errors into the stable `SchemaErrorItem` shape (so the
 * underlying validator stays swappable per ADR-0009).
 */
export class SchemaValidator {
  readonly #ajv: Ajv;
  readonly #cache = new WeakMap<object, ValidateFunction>();

  constructor() {
    this.#ajv = new Ajv({
      strict: false, // schema subset is already validated by `assertSubset`
      allErrors: true,
      // Annotations are intentionally ignored — Ajv's defaults already do so.
    });
  }

  validate(schema: object, value: unknown): SchemaErrorItem[] {
    const validate = this.#compile(schema);
    if (validate(value)) return [];
    return (validate.errors ?? []).map(toItem);
  }

  #compile(schema: object): ValidateFunction {
    const cached = this.#cache.get(schema);
    if (cached !== undefined) return cached;
    const fn = this.#ajv.compile(schema);
    this.#cache.set(schema, fn);
    return fn;
  }
}

function toItem(err: ErrorObject): SchemaErrorItem {
  return {
    pointer: err.instancePath === "" ? "/" : err.instancePath,
    keyword: err.keyword,
    message: err.message ?? "schema validation failed",
  };
}
