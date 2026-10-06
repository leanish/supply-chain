/**
 * What fails. A PR fails on findings it adds (unless excepted) and on any
 * malware in head, inherited or not; inherited findings are warnings. A full
 * scan fails on every finding without a valid exception.
 */
import { unexcusedProblem, type Exceptions } from "./exceptions.ts";
import type { Comparison, Finding } from "./findings.ts";
import type { Snapshot } from "./snapshot.ts";

export interface FindingVerdict {
  readonly failures: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

export function comparisonVerdict(comparison: Comparison, exceptions: Exceptions, snapshot: Snapshot, today: string): FindingVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const finding of comparison.added) {
    const problem = unexcusedProblem(finding, exceptions, snapshot, today);
    if (problem !== undefined) failures.push(`new: ${problem}`);
  }
  for (const finding of comparison.inherited) {
    if (finding.malicious) failures.push(`inherited: ${unexcusedProblem(finding, exceptions, snapshot, today)!}`);
    else warnings.push(`inherited: ${describe(finding)}`);
  }
  const notes = comparison.fixed.map((finding) => `fixed: ${describe(finding)}`);
  return { failures, warnings, notes };
}

export function scanVerdict(findings: ReadonlyArray<Finding>, exceptions: Exceptions, snapshot: Snapshot, today: string): FindingVerdict {
  const failures: string[] = [];
  const notes: string[] = [];
  for (const finding of findings) {
    const problem = unexcusedProblem(finding, exceptions, snapshot, today);
    if (problem === undefined) notes.push(`excepted: ${describe(finding)}`);
    else failures.push(problem);
  }
  return { failures, warnings: [], notes };
}

export function describe(finding: Finding): string {
  const aliases = finding.ids.filter((id) => id !== finding.advisory);
  const extra = [finding.severity, aliases.length > 0 ? aliases.join(", ") : undefined].filter((part) => part !== undefined);
  return `${finding.name}@${finding.version}: ${finding.advisory}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}${
    finding.summary === undefined ? "" : ` ${finding.summary}`
  }`;
}
