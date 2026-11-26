/**
 * Small per-generation JSON state files (stop intent, stall evidence, heartbeat, stop progress):
 * written by rename so a reader sees the previous content or the new one, never a torn file, and
 * read as `unknown` so every caller parses its own shape at the boundary.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

// Windows refuses to replace a file another process (antivirus, the indexer, a lock-free reader) has open for a
// moment; those codes clear on their own. One bounded retry policy for every writer that renames over a live file.
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const;

export function isTransientRenameError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		TRANSIENT_RENAME_CODES.has(error.code)
	);
}

/** Runs `rename`, retrying a transiently refused replace; any other error, or the last refusal, is thrown as is. */
export async function renameRetryingTransient(rename: () => unknown): Promise<void> {
	for (const delayMs of [...RENAME_RETRY_DELAYS_MS, undefined]) {
		try {
			await rename();
			return;
		} catch (error) {
			if (delayMs === undefined || !isTransientRenameError(error)) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

export async function writeJsonAtomic(path: string, content: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(content)}\n`, { mode: 0o600 });
		await renameRetryingTransient(() => rename(temporary, path));
	} catch (cause) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw cause;
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
