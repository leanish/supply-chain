/** Existing repository overrides constrain proofs; new PR overrides cannot manufacture an age exemption. */
import { dirname, join } from "node:path";

import semver from "semver";

import type { Config } from "./config.ts";
import { directDependencies } from "./npm-lock.ts";
import { compatibleLine } from "./young-fixes.ts";
import { isObject } from "./json.ts";
import type { Tree } from "./tree.ts";
import { requirementSpec } from "./npm-required.ts";

export async function baseOverrides(base: Tree, lockfile: string): Promise<Readonly<Record<string, unknown>>> {
  const text = await base.read(join(dirname(lockfile), "package.json"));
  if (text === undefined) return {};
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const overrides = manifest["overrides"];
  if (overrides === undefined) return {};
  if (!isObject(overrides)) throw new Error("unreadable repository overrides");
  return { manifest, overrides };
}

export function overrideConstraints(settings: Readonly<Record<string, unknown>>, packages: Readonly<Record<string, unknown>>, path: string, name: string): string[] {
  if (!isObject(settings["overrides"])) return [];
  const chain = ancestors(packages, path, name);
  const result: string[] = [];
  const walk = (rules: Record<string, unknown>, offset: number): void => {
    for (const [selector, rule] of Object.entries(rules)) {
      if (selector === ".") continue;
      for (let index = offset; index < chain.length; index++) {
        if (!matches(selector, chain[index]!)) continue;
        const value = isObject(rule) ? rule["."] : rule;
        if (index === chain.length - 1 && value !== undefined) result.push(overrideRange(value, settings["manifest"], name));
        if (isObject(rule)) walk(rule, index + 1);
      }
    }
  };
  walk(settings["overrides"], 0);
  return result;
}

function ancestors(packages: Readonly<Record<string, unknown>>, path: string, name: string) {
  const result: Array<{ name: string; version?: string }> = [];
  for (let current = path; current !== "";) {
    const entry = packages[current];
    if (current === path && entry === undefined) result.unshift({ name });
    else {
      if (!isObject(entry) || typeof entry["version"] !== "string") throw new Error(`unreadable override placement ${current}`);
      const ownerName = typeof entry["name"] === "string" ? entry["name"] : current.slice(current.lastIndexOf("node_modules/") + 13);
      result.unshift({ name: ownerName, version: entry["version"] });
    }
    const cut = current.lastIndexOf("/node_modules/");
    current = cut === -1 ? "" : current.slice(0, cut);
  }
  return result;
}

function matches(selector: string, copy: { name: string; version?: string }): boolean {
  const cut = selector.lastIndexOf("@");
  const name = cut > 0 ? selector.slice(0, cut) : selector;
  if (name !== copy.name) return false;
  if (cut <= 0) return true;
  const range = selector.slice(cut + 1);
  if (semver.validRange(range) === null) throw new Error(`unreadable override selector ${selector}`);
  if (copy.version === undefined) throw new Error(`unsupported version-qualified override on a new required copy: ${selector}`);
  return semver.satisfies(copy.version, range);
}

function overrideRange(value: unknown, rawManifest: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name}: unreadable repository override`);
  if (!value.startsWith("$")) return requirementSpec(name, value).range;
  if (!isObject(rawManifest)) throw new Error(`${name}: unreadable override reference`);
  const key = value.slice(1);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const entries = rawManifest[field];
    if (isObject(entries) && typeof entries[key] === "string") return requirementSpec(name, entries[key]).range;
  }
  throw new Error(`${name}: unresolved override reference ${value}`);
}

/** Direct companions stay in their compatible line even when a registry requirement is broader. */
export function directLineConstraints(packages: Record<string, unknown>, path: string, name: string, config: Config): string[] {
  const direct = directDependencies({ packages }).find((entry) => entry.path === path && entry.name === name);
  if (direct === undefined) return [];
  const line = compatibleLine(config, { ecosystem: "npm", name }, direct.version).split(".").map(Number);
  if (line.length === 0 || line.length > 3 || line.some((part) => !Number.isSafeInteger(part))) throw new Error(`${name}: unreadable compatible line`);
  const lower = [...line, ...Array<number>(3 - line.length).fill(0)].join(".");
  const upper = [...line.slice(0, -1), line[line.length - 1]! + 1, ...Array<number>(3 - line.length).fill(0)].join(".");
  return [`>=${lower} <${upper}`];
}
