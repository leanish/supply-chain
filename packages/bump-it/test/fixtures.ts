import type { BumpCandidate } from "../../ci/src/candidates.ts";
export function candidate(overrides: Partial<BumpCandidate> = {}): BumpCandidate {
  return { ecosystem: "npm", name: "lib", from: "1.0.0", locations: ["package-lock.json#."], declarations: [{ lockfile: "package-lock.json", workspace: ".", declaredAs: "lib", spec: "^1.0.0" }], minor: { version: "1.1.0", line: "1" }, major: { version: "2.0.0", line: "2" }, problems: [], ...overrides };
}
