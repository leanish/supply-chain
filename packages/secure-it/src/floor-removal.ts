/** Security floors qualify alone, then together without locks; every discarded floor is reported. */
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Finding } from "../../ci/src/findings.ts";
import { type Floor, FLOORS_PATH, parseFloors } from "../../ci/src/floors.ts";
import type { Tree } from "../../ci/src/tree.ts";

import type { ChangePlan } from "./plan.ts";

export interface FloorRemoval {
  readonly floors: ReadonlyArray<Floor>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
  readonly notes: ReadonlyArray<string>;
}

export interface RemovalProbe {
  readonly files: ReadonlyMap<string, string>;
  readonly findings: ReadonlyArray<Finding>;
  readonly problems: ReadonlyArray<string>;
}

export interface ComputedRemoval {
  readonly plan?: ChangePlan;
  readonly files: ReadonlyMap<string, string>;
  readonly notes: ReadonlyArray<string>;
}

export const floorIdentity = (floor: Floor): string => JSON.stringify({ ...floor,
  locations: [...floor.locations].sort(), overridePaths: [...floor.overridePaths].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  advisories: [...floor.advisories].sort(),
});

export async function floorsOf(tree: Tree): Promise<Floor[]> {
  const text = await tree.read(FLOORS_PATH);
  return text === undefined ? [] : parseFloors(JSON.parse(text));
}

export async function selectRemovals(
  floors: ReadonlyArray<Floor>,
  probe: (floors: ReadonlyArray<Floor>) => Promise<RemovalProbe>,
  hash: (text: string) => string,
): Promise<ComputedRemoval> {
  const eligible: Floor[] = [];
  const notes: string[] = [];
  const ordered = floors.filter((floor) => floor.purpose === "security").sort((a, b) => floorIdentity(a).localeCompare(floorIdentity(b)));
  for (const floor of ordered) {
    const checked = await checkRemoval([floor], probe);
    if (checked.problems.length === 0) eligible.push(floor);
    else notes.push(retained(floor, checked.problems));
  }
  while (eligible.length > 0) {
    // Even a singleton is checked again here: this result supplies the joint proof's exact npm bytes.
    const checked = await checkRemoval(eligible, probe);
    if (checked.problems.length === 0 && checked.result !== undefined) {
      const files = checked.result.files;
      return {
        plan: {
          kind: "floor-removal", topic: "floor-removal", malware: false, moves: [], severity: undefined,
          packages: [...new Set(eligible.map((floor) => `${floor.ecosystem}|${floor.package}`))].sort(),
          floorRemoval: { floors: [...eligible], files: [...files].map(([path, content]) => ({ path, sha256: hash(content) })).sort((a, b) => a.path.localeCompare(b.path)), notes },
        },
        files,
        notes,
      };
    }
    // Drop one failing floor (or the last one for a resolution-wide failure), then resolve the whole remainder again.
    const index = eligible.findIndex((floor) => checked.result !== undefined && floorFindings(floor, checked.result.findings).length > 0);
    const [dropped] = eligible.splice(index === -1 ? eligible.length - 1 : index, 1);
    notes.push(retained(dropped!, checked.problems));
  }
  return { files: new Map(), notes };
}

async function checkRemoval(floors: ReadonlyArray<Floor>, probe: (floors: ReadonlyArray<Floor>) => Promise<RemovalProbe>): Promise<{ result?: RemovalProbe; problems: string[] }> {
  try {
    const result = await probe(floors);
    const problems = [...result.problems, ...floors.flatMap((floor) => floorFindings(floor, result.findings)
      .map((finding) => `${floor.package}@${finding.version} still has ${finding.advisory}`))];
    return { result, problems };
  } catch (err) {
    return { problems: [err instanceof Error ? err.message : String(err)] };
  }
}

export function floorFindings(floor: Floor, findings: ReadonlyArray<Finding>): ReadonlyArray<Finding> {
  return findings.filter((finding) => finding.ecosystem === floor.ecosystem && finding.name === floor.package &&
    finding.ids.some((id) => floor.advisories.includes(id)));
}

function retained(floor: Floor, problems: ReadonlyArray<string>): string {
  return `${floor.package} in ${floor.declaredIn}: floor retained (${problems.join("; ")})`;
}

/** Preserve record values and metadata; only the exact selected records disappear. */
export function withoutFloorRecords(text: string, removed: ReadonlyArray<Floor>): string {
  const raw = JSON.parse(text) as { floors: unknown[] };
  const parsed = parseFloors(raw);
  for (const floor of removed) {
    if (floor.purpose !== "security" || !parsed.some((candidate) => floorIdentity(candidate) === floorIdentity(floor))) {
      throw new Error(`${floor.package}: removal must name an existing security floor exactly`);
    }
  }
  const selected = new Set(removed.map(floorIdentity));
  return formatJson(text, { floors: raw.floors.filter((_record, index) => !selected.has(floorIdentity(parsed[index]!))) });
}

/** Delete the selected override's version, retaining its nested overrides and every other manifest field. */
export function withoutOverrides(text: string, floors: ReadonlyArray<Floor>): string {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  for (const floor of floors) {
    if (floor.ecosystem !== "npm" || floor.purpose !== "security") throw new Error("only npm security overrides can be removed");
    for (const path of floor.overridePaths) removeOverride(manifest["overrides"], path);
  }
  if (object(manifest["overrides"]) && Object.keys(manifest["overrides"]).length === 0) delete manifest["overrides"];
  return formatJson(text, manifest);
}

function removeOverride(node: unknown, path: ReadonlyArray<string>): void {
  const [key, ...rest] = path;
  if (!object(node) || key === undefined || !Object.hasOwn(node, key)) throw new Error(`missing override ${path.join(" > ")}`);
  if (rest.length > 0) {
    removeOverride(node[key], rest);
  } else if (object(node[key])) {
    if (!Object.hasOwn(node[key], ".")) throw new Error(`override ${key} has no own version`);
    delete node[key]["."];
  } else {
    delete node[key];
  }
  if (object(node[key]) && Object.keys(node[key]).length === 0) delete node[key];
}

export function formatJson(text: string, value: unknown): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /(?:\r?\n)([ \t]+)\S/.exec(text)?.[1] ?? 2;
  return JSON.stringify(value, null, indent).replaceAll("\n", newline) + (text.endsWith("\n") ? newline : "");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The removal plan is untrusted PR data; round-trip through the gate's strict floor parser. */
export function validRemoval(value: unknown): value is FloorRemoval {
  if (!object(value) || Object.keys(value).some((key) => !["floors", "files", "notes"].includes(key))) return false;
  if (!Array.isArray(value["floors"]) || !Array.isArray(value["files"]) || !Array.isArray(value["notes"])) return false;
  try {
    return validFloors(value["floors"]) && validFiles(value["files"]) && value["notes"].every((note) => typeof note === "string");
  } catch {
    return false;
  }
}

function validFloors(values: ReadonlyArray<unknown>): boolean {
  if (values.length === 0) return false;
  const floors = values as Floor[];
  const records = floors.map((floor) => ({
    ecosystem: floor.ecosystem, package: floor.package, version: floor.version, declaredIn: floor.declaredIn,
    selector: floor.ecosystem === "npm" ? floor.overridePaths : floor.locations,
    purpose: floor.purpose, advisories: floor.advisories, reason: floor.reason, added: floor.added,
  }));
  if (!isDeepStrictEqual(parseFloors({ floors: records }), floors)) return false;
  return floors.every((floor) => floor.purpose === "security" && safeFile(floor.declaredIn) &&
    (floor.ecosystem !== "npm" || basename(floor.declaredIn) === "package.json"));
}

function validFiles(files: ReadonlyArray<unknown>): boolean {
  if (!files.every(validFile)) return false;
  if (!files.some((file) => file.path === FLOORS_PATH)) return false;
  return new Set(files.map((file) => file.path)).size === files.length;
}

function validFile(file: unknown): file is { path: string; sha256: string } {
  if (!object(file) || Object.keys(file).some((key) => !["path", "sha256"].includes(key))) return false;
  if (!safeFile(file["path"]) || typeof file["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(file["sha256"])) return false;
  return file["path"] === FLOORS_PATH || ["package.json", "package-lock.json", "npm-shrinkwrap.json"].includes(basename(file["path"]));
}

export function safeFile(path: unknown): path is string {
  return typeof path === "string" && path !== "" && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
