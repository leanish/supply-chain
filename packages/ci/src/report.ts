/**
 * The run's report: a JSON document for machines (secure-it reads it, the
 * daily publisher posts its verdict), plus GitHub annotations and a markdown
 * step summary for people. `completed` says whether the gate ran to the end;
 * `verdict` is `fail` whenever it didn't.
 */
import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";

export const REPORT_SCHEMA_VERSION = 1;

export interface Report {
  readonly schemaVersion: number;
  readonly mode: "compare" | "scan";
  readonly tool: { readonly commit: string | undefined; readonly osvScanner: string | undefined };
  /** sha256 of supply-chain.json as read, or `default` without one. */
  readonly configDigest: string;
  readonly baseSha: string | undefined;
  readonly headSha: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly completed: boolean;
  readonly verdict: "pass" | "fail";
  readonly failures: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly error: string | undefined;
}

export function configDigest(text: string | undefined): string {
  return text === undefined ? "default" : `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export interface ReportSinks {
  /** Where the JSON report goes, if anywhere. */
  readonly reportPath: string | undefined;
  /** `$GITHUB_STEP_SUMMARY`, if set. */
  readonly summaryPath: string | undefined;
  /** Whether to print `::error::` / `::warning::` workflow commands. */
  readonly annotations: boolean;
  readonly log: (line: string) => void;
}

export async function emitReport(report: Report, sinks: ReportSinks): Promise<void> {
  const escape = (text: string) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  for (const failure of report.failures) sinks.log(sinks.annotations ? `::error::${escape(failure)}` : `✗ ${failure}`);
  if (report.error !== undefined) sinks.log(sinks.annotations ? `::error::${escape(report.error)}` : `✗ ${report.error}`);
  for (const warning of report.warnings) sinks.log(sinks.annotations ? `::warning::${escape(warning)}` : `! ${warning}`);
  for (const gap of report.gaps) sinks.log(`? gap: ${gap}`);
  for (const note of report.notes) sinks.log(`· ${note}`);
  sinks.log(`supply-chain ${report.mode}: ${report.verdict}${report.completed ? "" : " (didn't complete)"}`);
  if (sinks.reportPath !== undefined) await writeFile(sinks.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (sinks.summaryPath !== undefined) await appendFile(sinks.summaryPath, markdownSummary(report));
}

export function markdownSummary(report: Report): string {
  const section = (title: string, lines: ReadonlyArray<string>) =>
    lines.length === 0 ? "" : `\n### ${title} (${lines.length})\n\n${lines.map((line) => `- ${line.replaceAll("|", "\\|")}`).join("\n")}\n`;
  const outcome = !report.completed ? "❌ didn't complete" : report.verdict === "pass" ? "✅ pass" : "❌ fail";
  const against = report.baseSha === undefined ? "" : ` against \`${report.baseSha.slice(0, 12)}\``;
  return [
    `## supply-chain ${report.mode}: ${outcome}\n`,
    `\`${report.headSha.slice(0, 12)}\`${against}, advisories as of ${report.startedAt}.\n`,
    report.error === undefined ? "" : `\n**Error:** ${report.error}\n`,
    section("Failures", report.failures),
    section("Warnings", report.warnings),
    section("Coverage gaps", report.gaps),
    section("Notes", report.notes),
    "\n",
  ].join("");
}
