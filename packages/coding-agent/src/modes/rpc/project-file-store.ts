/**
 * The stored-bytes side of the project file verbs (`read_project_file`/`write_project_file`, the project MCP file and
 * skill file verbs): reading a resolved file without following a link, its etag, the atomic replace, and one write at
 * a time per file inside the engine.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { NO_FOLLOW, PROJECT_FILE_MAX_BYTES } from "./project-file-path.ts";

export type Stored =
	| { readonly kind: "missing" }
	| { readonly kind: "refused" }
	| { readonly kind: "too_large" }
	| { readonly kind: "file"; readonly bytes: Buffer; readonly mode: number };

const writeChains = new Map<string, Promise<unknown>>();

export function etagOf(bytes: Buffer): string {
	return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Reads the stored bytes without following a link and without blocking on a FIFO swapped in after resolution; the
 * size is checked on the open handle before anything is read.
 */
export async function readStored(absolute: string): Promise<Stored> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(absolute, constants.O_RDONLY | NO_FOLLOW | (constants.O_NONBLOCK ?? 0));
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return { kind: "missing" };
		if (code === "ELOOP") return { kind: "refused" };
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) return { kind: "refused" };
		if (stat.size > PROJECT_FILE_MAX_BYTES) return { kind: "too_large" };
		return { kind: "file", bytes: await handle.readFile(), mode: stat.mode & 0o777 };
	} finally {
		await handle.close();
	}
}

/** Thrown when the parent folder no longer resolves to itself, i.e. a folder on the way was swapped for a link. */
export class ParentMoved extends Error {}

async function assertParentInPlace(folder: string): Promise<void> {
	if ((await realpath(folder)) !== folder) throw new ParentMoved(folder);
}

/**
 * Temp file + rename in the resolved folder, keeping an existing file's permissions. The folder is re-resolved before
 * the temp file is written and again before the rename, so a folder swapped for a link after resolution is refused
 * instead of followed (the remaining window between that check and the syscall needs a local writer racing it).
 */
export async function replaceAtomically(absolute: string, content: string, mode: number | undefined): Promise<void> {
	const folder = dirname(absolute);
	const temp = join(folder, `.${basename(absolute)}.${randomUUID()}.tmp`);
	await assertParentInPlace(folder);
	try {
		await writeFile(temp, content, { flag: "wx", mode: mode ?? 0o644 });
		if (mode !== undefined) await chmod(temp, mode);
		await assertParentInPlace(folder);
		await rename(temp, absolute);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/** Runs `write` after every earlier write queued for `key`; a write queued behind a failed one still runs. */
export async function serializeWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
	const previous = writeChains.get(key) ?? Promise.resolve();
	// The caller never receives the earlier caller's error.
	const next = previous.then(write, write);
	writeChains.set(key, next);
	try {
		return await next;
	} finally {
		if (writeChains.get(key) === next) writeChains.delete(key);
	}
}
