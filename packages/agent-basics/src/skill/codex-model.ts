// Copied from leanish/leanish-development core/runtime/src/skill/codex-model.ts at c6282df; see PROVENANCE.md.
/**
 * Codex model families a descriptor may name instead of a concrete model id
 * (`model: luna` instead of `model: gpt-6-luna`). A family resolves to the
 * newest *listed* `gpt-<version>-<family>` in the catalog Codex reports
 * (`codex debug models`): the one fetched with its credentials, or the one
 * bundled with the installed CLI when it can't fetch.
 */
export const CODEX_MODEL_FAMILIES: ReadonlyArray<string> = ["sol", "astra", "luna"];

export interface CodexCatalogModel {
  readonly slug: string;
  readonly visibility?: string;
  readonly supportedEfforts: ReadonlyArray<string>;
}

export interface ResolvedCodexModel {
  readonly slug: string;
  /** Efforts the catalog lists for the model; empty when the catalog doesn't know it. */
  readonly supportedEfforts: ReadonlyArray<string>;
}

export function isCodexModelFamily(model: string): boolean {
  return CODEX_MODEL_FAMILIES.includes(model);
}

/** Parses `codex debug models` output (`{"models": [...]}`); throws when it isn't that shape. */
export function parseCodexCatalog(stdout: string): ReadonlyArray<CodexCatalogModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`codex debug models: output is not JSON (${(err as Error).message})`);
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    throw new Error("codex debug models: output has no `models` array");
  }
  return models.flatMap((entry): CodexCatalogModel[] => {
    if (typeof entry?.slug !== "string") return [];
    const levels: unknown[] = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
    const supportedEfforts = levels.flatMap((level) => {
      const effort = typeof level === "string" ? level : (level as { effort?: unknown } | null)?.effort;
      return typeof effort === "string" ? [effort] : [];
    });
    return [
      {
        slug: entry.slug,
        ...(typeof entry.visibility === "string" ? { visibility: entry.visibility } : {}),
        supportedEfforts,
      },
    ];
  });
}

/**
 * A family becomes its newest listed `gpt-<version>-<family>` (versions compare
 * by integer parts, so 6.10 > 6.9), failing rather than falling back to an
 * older or unlisted model. Any other name is a concrete model id, kept as is.
 */
export function resolveCodexModel(
  model: string,
  catalog: ReadonlyArray<CodexCatalogModel>,
): ResolvedCodexModel {
  if (!isCodexModelFamily(model)) {
    return { slug: model, supportedEfforts: catalog.find((entry) => entry.slug === model)?.supportedEfforts ?? [] };
  }
  const pattern = new RegExp(`^gpt-(\\d+(?:\\.\\d+)*)-${model}$`);
  const candidates = catalog.flatMap((entry) => {
    const match = entry.visibility === "list" ? pattern.exec(entry.slug) : null;
    return match?.[1] !== undefined ? [{ entry, version: match[1].split(".").map(Number) }] : [];
  });
  const newest = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, candidate) => (best === undefined || compareVersions(candidate.version, best.version) > 0 ? candidate : best),
    undefined,
  );
  if (newest === undefined) {
    throw new Error(`no listed gpt-<version>-${model} model in Codex's model catalog`);
  }
  return { slug: newest.entry.slug, supportedEfforts: newest.entry.supportedEfforts };
}

/** Fails when the catalog lists the model's efforts and `effort` isn't one of them. */
export function assertEffortSupported(resolved: ResolvedCodexModel, effort: string | undefined): void {
  if (effort === undefined || resolved.supportedEfforts.length === 0) return;
  if (!resolved.supportedEfforts.includes(effort)) {
    throw new Error(
      `effort '${effort}' is not supported by ${resolved.slug} (supported: ${resolved.supportedEfforts.join(", ")})`,
    );
  }
}

function compareVersions(left: ReadonlyArray<number>, right: ReadonlyArray<number>): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
