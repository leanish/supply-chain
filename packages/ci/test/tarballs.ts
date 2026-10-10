/** Synthetic npm tarballs for tests: ustar entries, gzipped, served as a registry would. */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { FetchArchive } from "../src/npm-bundles.ts";

export interface TarEntry {
  readonly path: string;
  readonly body?: string | Buffer;
  readonly type?: string;
  /** Written as a pax `path` record instead of in the header. */
  readonly pax?: boolean;
  /** Written as a GNU long name entry instead of in the header. */
  readonly gnu?: boolean;
}

export function header(path: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(path, 0, 100, "utf8");
  block.write("0000644\0", 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  block.write("00000000000\0", 136, "latin1");
  block.write(type, 156, "latin1");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

function padded(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function paxRecord(key: string, value: string): string {
  const text = ` ${key}=${value}\n`;
  let length = text.length + 1;
  while (`${length}${text}`.length !== length) length++;
  return `${length}${text}`;
}

export function tar(entries: ReadonlyArray<TarEntry>, end = true): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = typeof entry.body === "string" ? Buffer.from(entry.body) : (entry.body ?? Buffer.alloc(0));
    let name = entry.path;
    if (entry.pax === true) {
      const records = Buffer.from(paxRecord("path", entry.path));
      blocks.push(header("PaxHeader", records.length, "x"), padded(records));
      name = "placeholder";
    }
    if (entry.gnu === true) {
      const long = Buffer.from(`${entry.path}\0`);
      blocks.push(header("././@LongLink", long.length, "L"), padded(long));
      name = "placeholder";
    }
    blocks.push(header(name, body.length, entry.type ?? "0"), padded(body));
  }
  if (end) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function manifest(name: string, version: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, version, ...extra });
}


export function archive(entries: ReadonlyArray<TarEntry>, end = true): { readonly bytes: Buffer; readonly integrity: string } {
  const bytes = gzipSync(tar(entries, end));
  return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

export function serving(files: Record<string, Buffer>, requests: string[] = [], chunk = 7_000): FetchArchive {
  return async (url) => {
    requests.push(url);
    const bytes = files[url];
    if (bytes === undefined) return { ok: false, status: 404, body: null };
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (let at = 0; at < bytes.length; at += chunk) yield bytes.subarray(at, at + chunk);
      })(),
    };
  };
}

