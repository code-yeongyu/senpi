/**
 * Small per-generation JSON state files (stop intent, stall evidence, heartbeat, stop progress):
 * written by rename so a reader sees the previous content or the new one, never a torn file, and
 * read as `unknown` so every caller parses its own shape at the boundary.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { renameRetryingTransient } from "../../utils/paths.ts";

export interface WriteJsonAtomicOptions {
	/** The rename that publishes the staged file; the real one unless a test drives a refusal. */
	readonly rename?: (from: string, to: string) => Promise<void>;
}

export async function writeJsonAtomic(
	path: string,
	content: unknown,
	options: WriteJsonAtomicOptions = {},
): Promise<void> {
	const publish = options.rename ?? rename;
	const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(content)}\n`, { mode: 0o600 });
		await renameRetryingTransient(() => publish(temporary, path));
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
