import { gzipSync } from "node:zlib";

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const encoder = new TextEncoder();

function splitPath(path: string): { readonly name: string; readonly prefix: string } {
	if (!/^[\x20-\x7e]+$/.test(path)) throw new Error(`tar path must be printable ASCII: ${path}`);
	if (path.length <= NAME_MAX) return { name: path, prefix: "" };
	for (let slash = path.lastIndexOf("/", PREFIX_MAX); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
		if (path.length - slash - 1 <= NAME_MAX) return { name: path.slice(slash + 1), prefix: path.slice(0, slash) };
	}
	throw new Error(`tar path does not fit a ustar header: ${path}`);
}

function header(path: string, size: number): Uint8Array {
	const block = new Uint8Array(BLOCK);
	const text = (offset: number, value: string) => block.set(encoder.encode(value), offset);
	const octal = (offset: number, width: number, value: number) =>
		text(offset, `${value.toString(8).padStart(width - 1, "0")}\0`);
	const { name, prefix } = splitPath(path);
	text(0, name);
	octal(100, 8, 0o644);
	octal(108, 8, 0);
	octal(116, 8, 0);
	octal(124, 12, size);
	octal(136, 12, 0);
	text(148, "        ");
	text(156, "0");
	text(257, "ustar\0");
	text(263, "00");
	text(345, prefix);
	const checksum = block.reduce((sum, byte) => sum + byte, 0);
	text(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
	return block;
}

/**
 * A gzip ustar archive whose bytes depend only on `files`: entries in sorted path order, each with mode 0644,
 * uid/gid 0, mtime 0 and no owner names, and a gzip header with no timestamp and the "unknown" OS byte.
 * Bun.Archive stamps every entry with the build time, so two builds of the same files differ.
 */
export function deterministicTarGz(files: Record<string, Uint8Array>): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const path of Object.keys(files).sort()) {
		const data = files[path];
		if (data === undefined) continue;
		parts.push(header(path, data.length), data, new Uint8Array((BLOCK - (data.length % BLOCK)) % BLOCK));
	}
	parts.push(new Uint8Array(BLOCK * 2));
	const gzip = gzipSync(Buffer.concat(parts), { level: 9 });
	gzip.fill(0, 4, 8);
	gzip[9] = 0xff;
	return new Uint8Array(gzip);
}
