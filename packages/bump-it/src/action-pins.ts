/** A workflow can use several lines of the same action: each source version has its own target. */
import { commentTag, readActionsInventory } from "../../ci/src/actions-inventory.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { pinsLanded } from "../../remediation/src/edit-checks.ts";

import type { PlannedMove } from "./plan.ts";

export async function plannedPinsLanded(moves: ReadonlyArray<PlannedMove>, base: Tree, head: Tree): Promise<string[]> {
  const pins = moves.filter((move) => move.mechanism === "action-pin");
  if (pins.length === 0) return [];
  const before = (await readActionsInventory(base)).uses;
  const after = (await readActionsInventory(head)).uses;
  const problems: string[] = [];
  const simple = pins.flatMap((pin) => pin.locations.flatMap((file) => {
    const uses = before.filter((use) => use.file === file && use.name === pin.name.toLowerCase());
    return uses.length > 0 && uses.every((use) => commentTag(use) === pin.from) ? [{ name: pin.name, locations: [file], to: pin.to, commitSha: pin.commitSha }] : [];
  }));
  problems.push(...await pinsLanded(simple, head));
  for (const file of new Set(pins.flatMap((pin) => pin.locations))) {
    const was = before.filter((use) => use.file === file);
    const now = after.filter((use) => use.file === file);
    if (was.length !== now.length) { problems.push(`${file}: action uses were added or removed`); continue; }
    for (let index = 0; index < was.length; index++) {
      const use = was[index]!;
      const landed = now[index]!;
      const move = pins.find((pin) => pin.locations.includes(file) && pin.name.toLowerCase() === use.name && pin.from === commentTag(use));
      if (move === undefined) {
        if (use.ref !== landed.ref || use.comment !== landed.comment) problems.push(`${file}: ${use.name} at ${commentTag(use) ?? use.ref} changed outside its planned source version`);
      } else if (landed.ref !== move.commitSha || commentTag(landed) !== move.to) {
        problems.push(`${file}: ${use.name} from ${move.from} must land at ${move.commitSha} # ${move.to}`);
      }
    }
  }
  for (const pin of pins) {
    for (const file of pin.locations) {
      if (!before.some((use) => use.file === file && use.name === pin.name.toLowerCase() && commentTag(use) === pin.from)) problems.push(`${file} has no source use of ${pin.name}@${pin.from}`);
    }
  }
  return [...new Set(problems)];
}
