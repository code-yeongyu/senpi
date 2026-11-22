/**
 * Fixture for test/suite/no-sync-on-move-path.test.ts: whole-file synchronous work an audit that knew only
 * `readFileSync`/`writeFileSync`/`appendFileSync` by name never saw - an aliased copy, a namespace-import tree copy,
 * a descriptor read and a zlib call. The audit seeds it as an extra root to prove the class is caught.
 *
 * Nothing imports this file at runtime.
 */
import * as fs from "node:fs";
import { copyFileSync as copyInPlace, openSync, readSync } from "node:fs";
import * as zlib from "node:zlib";

export function fixtureCopyBundle(from: string, to: string): void {
	copyInPlace(from, to);
}

export function fixtureCopyTree(from: string, to: string): void {
	fs.cpSync(from, to, { recursive: true });
}

export function fixtureReadHeader(path: string): number {
	return readSync(openSync(path, "r"), Buffer.alloc(16));
}

export function fixtureCompress(data: Buffer): Buffer {
	return zlib.gzipSync(data);
}
