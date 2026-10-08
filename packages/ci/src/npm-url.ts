/** Registry lookups keep package names and versions in separate encoded path components. */
import { NPM_REGISTRY } from "./npm-lock.ts";

export function npmPackageUrl(name: string, version?: string): string {
  const packageUrl = `${NPM_REGISTRY}/${encodedComponent(name)}`;
  return version === undefined ? packageUrl : `${packageUrl}/${encodedComponent(version)}`;
}

function encodedComponent(value: string): string {
  // encodeURIComponent leaves dot segments intact; URL parsing would normalize them.
  if (value === "" || value === "." || value === "..") throw new Error(`invalid npm registry URL component: ${JSON.stringify(value)}`);
  return encodeURIComponent(value);
}
