/** Recomputed npm floors keep matching PR history and the clean merge's non-npm floor records. */
import { isDeepStrictEqual } from "node:util";

import { FLOORS_PATH, parseFloors, type Floor } from "../../ci/src/floors.ts";
import { formatManifest } from "../../remediation/src/manifest-format.ts";

export function reconcileNpmFloors(files: ReadonlyMap<string, string>, mergedText: string | undefined): ReadonlyMap<string, string> {
  const computedText = files.get(FLOORS_PATH);
  if (computedText === undefined || mergedText === undefined) return files;
  const computed = JSON.parse(computedText) as { floors: Record<string, unknown>[] };
  const merged = JSON.parse(mergedText) as { floors: Record<string, unknown>[] };
  const computedFloors = parseFloors(computed);
  const mergedFloors = parseFloors(merged);
  const npmFloors = computed.floors.filter((_record, index) => computedFloors[index]!.ecosystem === "npm");
  for (let index = 0; index < computedFloors.length; index++) {
    const floor = computedFloors[index]!;
    if (floor.ecosystem !== "npm" || floor.purpose !== "security") continue;
    const previous = mergedFloors.find((candidate) => sameFloor(floor, candidate));
    if (previous === undefined) continue;
    computed.floors[index]!["added"] = previous.added;
    computed.floors[index]!["reason"] = previous.reason;
  }
  computed.floors = [...npmFloors, ...merged.floors.filter((_record, index) => mergedFloors[index]!.ecosystem !== "npm")];
  parseFloors(computed);
  return new Map([...files, [FLOORS_PATH, formatManifest(mergedText, computed)]]);
}

function sameFloor(floor: Floor, candidate: Floor): boolean {
  return isDeepStrictEqual({ ...floor, added: "", reason: "" }, { ...candidate, added: "", reason: "" });
}
