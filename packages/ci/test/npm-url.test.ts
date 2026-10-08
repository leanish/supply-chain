import { describe, expect, it } from "vitest";

import { NpmRegistry } from "../src/npm-registry.ts";
import { sourceRepository } from "../src/source-repos.ts";
import { fakeFetch } from "./fake-fetch.ts";

const REGISTRY = "https://registry.npmjs.org";
const NAMES = ["lib", "@scope/lib", "Legacy.Pkg", "@scope/lib/extra", "lib?query#fragment", "lib%2Fother", "lib\\other"];

describe("npm registry URLs", () => {
  it.each(NAMES)("keeps the packument name %s in one encoded path component", async (name) => {
    const url = `${REGISTRY}/${encodeURIComponent(name)}`;
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = fakeFetch({ [url]: { body: { time: {}, versions: {} } } }, requests);

    await new NpmRegistry(fetch).packument(name);

    expect(requests.map((request) => request.url)).toEqual([url]);
    expect(new URL(requests[0]!.url).origin).toBe(REGISTRY);
    expect(new URL(requests[0]!.url).search).toBe("");
    expect(new URL(requests[0]!.url).hash).toBe("");
  });

  it.each(NAMES)("keeps the manifest name %s and version in separate encoded path components", async (name) => {
    const version = "1/../../other?query#fragment%2F";
    const url = `${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = fakeFetch({ [url]: { body: { repository: "github:acme/lib" } } }, requests);

    const repository = await sourceRepository({ ecosystem: "npm", name, version }, { fetch, overrides: new Map(), mavenRepositories: [] });

    expect(repository).toBe("acme/lib");
    expect(requests.map((request) => request.url)).toEqual([url]);
    expect(new URL(requests[0]!.url).pathname).toBe(`/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    expect(new URL(requests[0]!.url).search).toBe("");
    expect(new URL(requests[0]!.url).hash).toBe("");
  });

  it.each(["", ".", ".."])('refuses the empty or dot-segment name "%s" before fetching', async (name) => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = fakeFetch({}, requests);

    await expect(new NpmRegistry(fetch).packument(name)).rejects.toThrow("invalid npm registry URL component");
    await expect(sourceRepository({ ecosystem: "npm", name, version: "1.0.0" }, { fetch, overrides: new Map(), mavenRepositories: [] }))
      .rejects.toThrow("invalid npm registry URL component");
    expect(requests).toEqual([]);
  });

  it.each(["", ".", ".."])('refuses the empty or dot-segment version "%s" before fetching', async (version) => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = fakeFetch({}, requests);

    await expect(sourceRepository({ ecosystem: "npm", name: "lib", version }, { fetch, overrides: new Map(), mavenRepositories: [] }))
      .rejects.toThrow("invalid npm registry URL component");
    expect(requests).toEqual([]);
  });
});
