/**
 * What an npm package's own tarball bundles, read from the registry's archive
 * rather than from a lockfile: the evidence for fixes that arrive inside a
 * carrier (a bundled vulnerable copy can only change when its carrier does).
 *
 * The archive is fetched from the npm registry at the package's own tarball
 * URL (no redirects), authenticated against an expected sha512 integrity (the
 * locked one, or the packument's for a candidate), and read in memory as it
 * streams: gunzip, then tar, keeping only the package root `package.json` of
 * the carrier and of every bundled package (`node_modules/…/<name>/package.json`
 * chains from the root). Nothing is extracted or run.
 *
 * Fixed budgets bound each archive (compressed and unpacked bytes, entries,
 * manifest size, a deadline) and the whole run (bytes downloaded). Anything
 * over budget, truncated, unauthenticated, ambiguous (a path twice) or using
 * an entry type npm doesn't pack (links, devices) reads as `unknown` with its
 * reason: never as an empty bundle, and never before the integrity check
 * passed over the complete archive.
 */
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import semver from "semver";

import { isObject } from "./json.ts";
import { fromRegistry, type LockedPackage, NPM_REGISTRY } from "./npm-lock.ts";

const MIB = 1024 * 1024;

export interface BundleLimits {
  readonly compressedBytes: number;
  readonly unpackedBytes: number;
  readonly entries: number;
  readonly manifestBytes: number;
  /** Bytes downloaded across every archive one reader reads. */
  readonly runBytes: number;
  readonly timeoutMs: number;
}

/** aws-cdk-lib 2.273.0 is 37 MB compressed, 137 MB unpacked, 7,577 entries. */
export const BUNDLE_LIMITS: BundleLimits = {
  compressedBytes: 128 * MIB,
  unpackedBytes: 512 * MIB,
  entries: 50_000,
  manifestBytes: MIB,
  runBytes: 1024 * MIB,
  timeoutMs: 180_000,
};

/** The archive download: a registry URL, never followed through a redirect. */
export type FetchArchive = (url: string, signal: AbortSignal) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
}>;

/** Production download: plain `fetch`, refusing redirects. */
export const fetchArchive: FetchArchive = async (url, signal) => {
  const response = await fetch(url, { redirect: "error", signal });
  return { ok: response.ok, status: response.status, body: response.body };
};

export interface BundledManifest {
  /** Inside the carrier: `node_modules/minimatch`, `node_modules/a/node_modules/b`. */
  readonly path: string;
  /** The key it's installed under (the path's last name); `name` differs for an `npm:` alias. */
  readonly installedAs: string;
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta: Readonly<Record<string, unknown>>;
}

export type BundleContents =
  | { readonly complete: true; readonly packages: ReadonlyArray<BundledManifest> }
  | { readonly complete: false; readonly reason: string };

/** Reads registry archives once per name, version and integrity, within one shared run budget. */
export class BundleReader {
  readonly #fetch: FetchArchive;
  readonly #limits: BundleLimits;
  readonly #cache = new Map<string, Promise<BundleContents>>();
  #spent = 0;

  constructor(fetch: FetchArchive = fetchArchive, limits: BundleLimits = BUNDLE_LIMITS) {
    this.#fetch = fetch;
    this.#limits = limits;
  }

  /** `name@version`'s registry archive, authenticated against `integrity` (an SRI string with a sha512). */
  read(name: string, version: string, integrity: string | undefined): Promise<BundleContents> {
    const key = `${name}@${version}|${integrity ?? ""}`;
    let cached = this.#cache.get(key);
    if (cached === undefined) {
      cached = this.#read(name, version, integrity).catch((error: unknown) => unknown(`${name}@${version}: ${error instanceof Error ? error.message : String(error)}`));
      this.#cache.set(key, cached);
    }
    return cached;
  }

  async #read(name: string, version: string, integrity: string | undefined): Promise<BundleContents> {
    const expected = sha512Of(integrity);
    if (expected === undefined) return unknown(`${name}@${version}: no sha512 integrity to authenticate its archive against`);
    const url = tarballUrl(name, version);
    const signal = AbortSignal.timeout(this.#limits.timeoutMs);
    const response = await this.#fetch(url, signal);
    if (!response.ok || response.body === null) return unknown(`${name}@${version}: GET ${url} answered HTTP ${response.status}`);
    const body = response.body;
    const hash = createHash("sha512");
    const tar = new TarReader(this.#limits);
    let compressed = 0;
    const limits = this.#limits;
    const spend = (bytes: number) => {
      compressed += bytes;
      this.#spent += bytes;
      if (compressed > limits.compressedBytes) throw new Error(`archive over ${limits.compressedBytes} compressed bytes`);
      if (this.#spent > limits.runBytes) throw new Error(`the run's archive budget (${limits.runBytes} bytes) is spent`);
    };
    await pipeline(
      async function* download() {
        for await (const chunk of body) {
          spend(chunk.byteLength);
          hash.update(chunk);
          yield chunk;
        }
      },
      createGunzip(),
      async function unpack(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          tar.push(chunk);
          tar.failure();
        }
      },
      { signal },
    );
    if (hash.digest("base64") !== expected) return unknown(`${name}@${version}: the archive doesn't match its sha512 integrity`);
    const entries = tar.finish();
    return contentsOf(name, version, entries);
  }
}

function unknown(reason: string): BundleContents {
  return { complete: false, reason };
}

/** The npm registry's own tarball URL for `name@version`, as `fromRegistry` accepts it. */
export function tarballUrl(name: string, version: string): string {
  const unscoped = name.slice(name.lastIndexOf("/") + 1);
  const url = `${NPM_REGISTRY}/${name}/-/${unscoped}-${version}.tgz`;
  if (!fromRegistry({ name, version, path: "", resolved: url, bundled: false, integrity: undefined }, [NPM_REGISTRY])) {
    throw new Error(`no registry tarball URL can be formed for ${JSON.stringify(name)}@${JSON.stringify(version)}`);
  }
  return url;
}

/** The base64 sha512 digest an SRI string names; undefined without one, or with two that disagree. */
function sha512Of(integrity: string | undefined): string | undefined {
  const digests = new Set((integrity ?? "").trim().split(/\s+/).flatMap((part) => {
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(part);
    return match === null ? [] : [match[1]!];
  }));
  return digests.size === 1 ? [...digests][0] : undefined;
}

/** A bundled package root: `node_modules/<name>`, possibly scoped, possibly under another bundled package. */
const PACKAGE_ROOT = /^(?:node_modules\/(?:@[^/]+\/[^/@][^/]*|[^/@][^/]*)\/)*node_modules\/(?:@[^/]+\/[^/@][^/]*|[^/@][^/]*)$/;

function contentsOf(name: string, version: string, manifests: ReadonlyMap<string, Buffer>): BundleContents {
  const root = manifests.get("package.json");
  if (root === undefined) return unknown(`${name}@${version}: the archive has no package.json`);
  const rootManifest = parseManifest(root);
  if (rootManifest === undefined || rootManifest["name"] !== name || rootManifest["version"] !== version) {
    return unknown(`${name}@${version}: the archive's package.json doesn't name ${name}@${version}`);
  }
  const packages: BundledManifest[] = [];
  for (const [file, bytes] of manifests) {
    if (file === "package.json") continue;
    const path = file.slice(0, -"/package.json".length);
    const installedAs = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const manifest = parseManifest(bytes);
    const read = manifest === undefined ? undefined : bundledManifest(path, installedAs, manifest);
    if (read === undefined) return unknown(`${name}@${version}: unreadable bundled manifest ${file}`);
    packages.push(read);
  }
  return { complete: true, packages: packages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

function parseManifest(bytes: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function bundledManifest(path: string, installedAs: string, manifest: Record<string, unknown>): BundledManifest | undefined {
  const { name, version } = manifest;
  if (typeof name !== "string" || name === "" || typeof version !== "string" || semver.valid(version) !== version) return undefined;
  const ranges = (field: string): Record<string, string> | undefined => {
    const value = manifest[field] ?? {};
    return isObject(value) && Object.values(value).every((spec) => typeof spec === "string") ? (value as Record<string, string>) : undefined;
  };
  const dependencies = ranges("dependencies");
  const optionalDependencies = ranges("optionalDependencies");
  const peerDependencies = ranges("peerDependencies");
  const meta = manifest["peerDependenciesMeta"] ?? {};
  if (dependencies === undefined || optionalDependencies === undefined || peerDependencies === undefined || !isObject(meta)) return undefined;
  return { path, installedAs, name, version, dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta: meta };
}

/**
 * Where an archive and a lockfile disagree about what a carrier ships: the
 * lockfile's bundled entries under `carrier` (its lockfile key) must be
 * exactly the archive's bundled packages, path by path, name and version
 * included. Empty when they agree.
 */
export function bundleMismatches(packages: ReadonlyArray<LockedPackage>, carrier: string, contents: Extract<BundleContents, { complete: true }>): string[] {
  const locked = new Map(packages
    .filter((pkg) => pkg.bundled && pkg.path.startsWith(`${carrier}/node_modules/`))
    .map((pkg) => [pkg.path.slice(carrier.length + 1), `${pkg.name}@${pkg.version}`]));
  const shipped = new Map(contents.packages.map((pkg) => [pkg.path, `${pkg.name}@${pkg.version}`]));
  const problems: string[] = [];
  for (const [path, label] of shipped) {
    const recorded = locked.get(path);
    if (recorded === undefined) problems.push(`${carrier} ships ${label} at ${path}, which the lockfile doesn't record`);
    else if (recorded !== label) problems.push(`${carrier} ships ${label} at ${path}, but the lockfile records ${recorded}`);
  }
  for (const [path, label] of locked) {
    if (!shipped.has(path)) problems.push(`the lockfile records ${label} at ${carrier}/${path}, which ${carrier}'s archive doesn't ship`);
  }
  return problems;
}

const BLOCK = 512;

interface Pending {
  readonly kind: "manifest" | "pax" | "longname" | "skip";
  readonly path: string;
  remaining: number;
  readonly chunks: Buffer[];
  padding: number;
}

/**
 * A tar reader fed in chunks, keeping only package root manifests. ustar and
 * old-GNU headers, pax extended headers (`path`, `size`) and GNU long names
 * are read; files and directories are the only entries accepted. The first
 * path segment (npm's `package/`) is dropped, as npm does when unpacking.
 */
class TarReader {
  readonly #limits: BundleLimits;
  readonly #manifests = new Map<string, Buffer>();
  readonly #seen = new Set<string>();
  #buffer: Buffer = Buffer.alloc(0);
  #pending: Pending | undefined;
  #pax: Record<string, string> = {};
  #longName: string | undefined;
  #unpacked = 0;
  #entries = 0;
  #ended = false;
  #error: Error | undefined;
  #prefix: string | undefined;

  constructor(limits: BundleLimits) {
    this.#limits = limits;
  }

  /** Throws the first problem found so far, so the download stops early. */
  failure(): void {
    if (this.#error !== undefined) throw this.#error;
  }

  push(chunk: Buffer): void {
    if (this.#error !== undefined) return;
    try {
      this.#unpacked += chunk.length;
      if (this.#unpacked > this.#limits.unpackedBytes) throw new Error(`archive over ${this.#limits.unpackedBytes} unpacked bytes`);
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    } catch (error) {
      this.#error = error instanceof Error ? error : new Error(String(error));
    }
  }

  finish(): ReadonlyMap<string, Buffer> {
    this.failure();
    if (!this.#ended) throw new Error("the archive ends before tar's end-of-archive blocks");
    return this.#manifests;
  }

  #drain(): void {
    for (;;) {
      if (this.#ended) {
        // Zero padding after the end-of-archive blocks is allowed; data isn't.
        if (this.#buffer.some((byte) => byte !== 0)) throw new Error("data after tar's end-of-archive blocks");
        this.#buffer = Buffer.alloc(0);
        return;
      }
      if (this.#pending !== undefined) {
        if (!this.#body(this.#pending)) return;
        continue;
      }
      if (this.#buffer.length < BLOCK) return;
      const header = this.#buffer.subarray(0, BLOCK);
      this.#buffer = this.#buffer.subarray(BLOCK);
      if (header.every((byte) => byte === 0)) {
        this.#ended = true;
        continue;
      }
      this.#header(header);
    }
  }

  /** Consumes body bytes of the pending entry; false when more input is needed. */
  #body(pending: Pending): boolean {
    if (pending.remaining > 0) {
      const take = Math.min(pending.remaining, this.#buffer.length);
      if (take === 0) return false;
      if (pending.kind !== "skip") pending.chunks.push(this.#buffer.subarray(0, take));
      this.#buffer = this.#buffer.subarray(take);
      pending.remaining -= take;
      if (pending.remaining > 0) return false;
    }
    if (pending.padding > 0) {
      const take = Math.min(pending.padding, this.#buffer.length);
      this.#buffer = this.#buffer.subarray(take);
      pending.padding -= take;
      if (pending.padding > 0) return false;
    }
    this.#pending = undefined;
    const body = Buffer.concat(pending.chunks);
    if (pending.kind === "manifest") this.#manifests.set(pending.path, body);
    else if (pending.kind === "pax") this.#pax = { ...this.#pax, ...parsePax(body) };
    else if (pending.kind === "longname") this.#longName = body.toString("utf8").replace(/\0+$/, "");
    return true;
  }

  #header(header: Buffer): void {
    if (++this.#entries > this.#limits.entries) throw new Error(`archive over ${this.#limits.entries} entries`);
    if (checksum(header) !== octal(header, 148, 8)) throw new Error("a tar header fails its checksum");
    const type = String.fromCharCode(header[156]!);
    const headerSize = octal(header, 124, 12);
    const pax = this.#pax;
    const longName = this.#longName;
    if (type !== "x" && type !== "L") {
      this.#pax = {};
      this.#longName = undefined;
    }
    const size = pax["size"] !== undefined && type !== "x" && type !== "L" ? Number(pax["size"]) : headerSize;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("a tar entry has an unreadable size");
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    const meta = (kind: Pending["kind"], cap: number) => {
      if (size > cap) throw new Error(`a tar ${kind === "pax" ? "pax header" : "long name"} over ${cap} bytes`);
      this.#pending = { kind, path: "", remaining: size, chunks: [], padding };
    };
    if (type === "x") return meta("pax", this.#limits.manifestBytes);
    if (type === "L") return meta("longname", 4096);
    if (type === "g") {
      // Global pax headers carry no path or size this reader uses.
      this.#pending = { kind: "skip", path: "", remaining: size, chunks: [], padding };
      return;
    }
    if (type !== "0" && type !== "\0" && type !== "5") throw new Error(`unsupported tar entry type ${JSON.stringify(type)}`);
    const raw = pax["path"] ?? longName ?? ustarPath(header);
    const path = this.#relative(raw, type === "5");
    if (type === "5") {
      if (size !== 0) throw new Error(`directory ${raw} has a size`);
      return;
    }
    if (this.#seen.has(path)) throw new Error(`the archive holds ${path} twice`);
    this.#seen.add(path);
    const manifest = path === "package.json" || (path.endsWith("/package.json") && PACKAGE_ROOT.test(path.slice(0, -"/package.json".length)));
    if (manifest && size > this.#limits.manifestBytes) throw new Error(`${path} is over ${this.#limits.manifestBytes} bytes`);
    this.#pending = { kind: manifest ? "manifest" : "skip", path, remaining: size, chunks: [], padding };
  }

  /** The path below the archive's top directory, which every entry must share. */
  #relative(raw: string, directory: boolean): string {
    const trimmed = directory ? raw.replace(/\/+$/, "") : raw;
    const segments = trimmed.split("/");
    if (trimmed.includes("\\") || trimmed.includes("\0") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`unsafe tar path ${JSON.stringify(raw)}`);
    }
    const [top, ...rest] = segments;
    this.#prefix ??= top;
    if (top !== this.#prefix) throw new Error(`tar paths under two top directories (${this.#prefix}, ${top})`);
    if (rest.length === 0 && !directory) throw new Error(`a file at the archive's top level: ${raw}`);
    return rest.join("/");
  }
}

function ustarPath(header: Buffer): string {
  const name = cString(header, 0, 100);
  const ustar = header.subarray(257, 262).toString("latin1") === "ustar";
  const prefix = ustar ? cString(header, 345, 155) : "";
  return prefix === "" ? name : `${prefix}/${name}`;
}

function cString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  // A high bit set is base-256 (sizes over 8 GB): far over any budget here.
  if ((field[0]! & 0x80) !== 0) throw new Error("a tar number in base-256");
  const text = field.toString("latin1").replace(/[\0 ]+$/, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("an unreadable tar number");
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum;
}

/** Records `<length> <key>=<value>\n`, each length counting its whole record. */
function parsePax(body: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) throw new Error("an unreadable pax header");
    const length = Number(body.subarray(offset, space).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > body.length) throw new Error("an unreadable pax header");
    const record = body.subarray(space + 1, offset + length).toString("utf8");
    if (!record.endsWith("\n") || !record.includes("=")) throw new Error("an unreadable pax header");
    const at = record.indexOf("=");
    records[record.slice(0, at)] = record.slice(at + 1, -1);
    offset += length;
  }
  return records;
}
