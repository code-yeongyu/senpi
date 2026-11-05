import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SessionHeader, StoredEntry } from "@earendil-works/pi-agent-core";
import { captureFileIdentity } from "../session-file-identity.ts";
import type { JsonlFileStamp } from "../session-import/jsonl-import.ts";
import type { FileIdentity } from "../session-transcript-journal.ts";

/** The binding's asynchronous whole-file projection writes; the default is the atomic replace below. A test seam for win32. */
export interface ProjectionFiles {
	replace(path: string, contents: string): Promise<void>;
}

export const codeOf = (error: unknown): string =>
	error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";

export function projectionImage(header: SessionHeader, entries: readonly StoredEntry[]): string {
	return [JSON.stringify(header), ...entries.map((entry) => entry.line)].map((line) => `${line}\n`).join("");
}

export async function stampOf(path: string): Promise<JsonlFileStamp | undefined> {
	try {
		const value = await stat(path);
		return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	}
}

/** Today's atomic replace, asynchronous: a temp file written and synced beside the target, then renamed over it. */
async function replaceAtomically(path: string, contents: string): Promise<FileIdentity | undefined> {
	const mode = (await modeOf(path)) ?? 0o600;
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const handle = await open(temp, "wx", mode);
	let identity: FileIdentity | undefined;
	try {
		await handle.writeFile(contents);
		await handle.sync();
		identity = await captureFileIdentity(handle.fd, path);
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return identity;
}

async function modeOf(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mode & 0o777;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	}
}

/** A provided ProjectionFiles is called as a method, so a class implementing it keeps its `this`; its identity is unknown. */
export async function replaceWith(
	files: ProjectionFiles | undefined,
	path: string,
	contents: string,
): Promise<FileIdentity | undefined> {
	if (files === undefined) return replaceAtomically(path, contents);
	await files.replace(path, contents);
	return undefined;
}
