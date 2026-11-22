import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MachineOpError } from "../errors.ts";
import type { GrepMatch, GrepResult } from "../types.ts";

const DEFAULT_LIMIT = 100;
const MAX_LINE_CHARS = 500;
const WALK_SKIP = new Set([".git", "node_modules"]);

/** Regular-expression search of one file or a directory tree; symlinks are never followed. */
export async function localGrep(
	root: string,
	pattern: string,
	limit: number | undefined,
	readMaxBytes: number,
	signal: AbortSignal,
): Promise<GrepResult> {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern);
	} catch (error) {
		throw new MachineOpError("invalid_pattern", `invalid pattern: ${(error as Error).message}`, { cause: error });
	}
	const effectiveLimit = limit ?? DEFAULT_LIMIT;
	if (!Number.isInteger(effectiveLimit) || effectiveLimit <= 0) {
		throw new MachineOpError("invalid_argument", "limit must be a positive integer");
	}
	const info = await stat(root);
	const files: string[] = [];
	if (info.isFile()) {
		if (info.size > readMaxBytes) {
			throw new MachineOpError(
				"limit_exceeded",
				`${root} is ${info.size} bytes, above the ${readMaxBytes}-byte read limit`,
			);
		}
		files.push(root);
	} else {
		const pending = [root];
		while (pending.length > 0) {
			const dir = pending.shift() as string;
			let dirents: Dirent[];
			try {
				dirents = await readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const dirent of dirents) {
				if (WALK_SKIP.has(dirent.name)) continue;
				const full = path.join(dir, dirent.name);
				if (dirent.isDirectory()) pending.push(full);
				else if (dirent.isFile()) files.push(full);
			}
		}
	}
	const matches: GrepMatch[] = [];
	for (const file of files) {
		if (signal.aborted) throw new MachineOpError("aborted", "Operation aborted");
		if (file !== root && (await stat(file)).size > readMaxBytes) continue;
		const content = await readFile(file);
		if (content.includes(0)) continue;
		const lines = content.toString("utf8").split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			if (!regex.test(lines[index])) continue;
			if (matches.length >= effectiveLimit) return { matches, truncated: true };
			matches.push({ path: file, line: index + 1, text: lines[index].slice(0, MAX_LINE_CHARS) });
		}
	}
	return { matches, truncated: false };
}
