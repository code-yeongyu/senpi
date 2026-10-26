/**
 * Small per-generation JSON state files (stop intent, stall evidence, heartbeat, stop progress):
 * written by rename so a reader sees the previous content or the new one, never a torn file, and
 * read as `unknown` so every caller parses its own shape at the boundary.
 */
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeJsonAtomic(path: string, content: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(content)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	} catch (cause) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw cause;
	}
}

/**
 * `writeJsonAtomic` for a record that must survive a machine crash once this resolves: the bytes are synced
 * before the rename, and the directory after it, so the new entry is not lost with an unsynced directory.
 */
export async function writeFileDurably(path: string, text: string): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(text, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} catch (cause) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw cause;
	}
	await syncDirectory(dirname(path));
}

/** Persists a directory's entries (a rename, link or unlink in it). Windows cannot open a directory to sync it. */
export async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;
	} catch {
		return undefined;
	}
}

export function ageOf(at: unknown, now: number): number | undefined {
	if (typeof at !== "string") return undefined;
	const parsed = Date.parse(at);
	return Number.isNaN(parsed) ? undefined : now - parsed;
}
