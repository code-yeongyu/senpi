/**
 * Per-monitor overflow file: lines a paced persistent watch matched beyond what one wake carries.
 * The wake names this file, so no matched line is lost to the batch cap. It lives in the session's
 * terminal state dir (not the watch's own SENPI_MONITOR_STATE_DIR, which belongs to the command and
 * is removed when the watch ends, while the agent may still need to read the overflow), and is
 * bounded: past MONITOR_OVERFLOW_FILE_MAX_BYTES it rotates to one `.1` copy. Files untouched for
 * longer than a durable watch can live are swept at session start.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { MonitorSpillResult } from "./monitor-overflow.ts";
import { DURABLE_MONITOR_EXPIRY_MS, MONITOR_OVERFLOW_FILE_MAX_BYTES } from "./shared.ts";

function overflowDir(terminalDir: string): string {
	return join(terminalDir, "overflow");
}

export function monitorOverflowPath(terminalDir: string, monitorId: string): string {
	return join(overflowDir(terminalDir), `${monitorId}.log`);
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Append `lines` to the watch's overflow file. Throws on a filesystem error. */
export function appendMonitorOverflow(
	terminalDir: string,
	monitorId: string,
	lines: readonly string[],
	maxBytes = MONITOR_OVERFLOW_FILE_MAX_BYTES,
): MonitorSpillResult {
	const path = monitorOverflowPath(terminalDir, monitorId);
	mkdirSync(overflowDir(terminalDir), { recursive: true, mode: 0o700 });
	let size = 0;
	try {
		size = statSync(path).size;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const rotated = size >= maxBytes;
	if (rotated) renameSync(path, `${path}.1`);
	appendFileSync(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
	return { path, rotated };
}

/** Remove overflow files (and rotated copies) not written for longer than a durable watch lives. */
export async function sweepMonitorOverflowFiles(
	terminalDir: string,
	now = Date.now(),
	maxAgeMs = DURABLE_MONITOR_EXPIRY_MS,
): Promise<number> {
	let names: string[];
	try {
		names = await readdir(overflowDir(terminalDir));
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}
	let removed = 0;
	for (const name of names) {
		if (!name.endsWith(".log") && !name.endsWith(".log.1")) continue;
		const path = join(overflowDir(terminalDir), name);
		const info = await stat(path).catch(() => undefined);
		if (info === undefined || now - info.mtimeMs <= maxAgeMs) continue;
		await unlink(path).catch((error: unknown) => {
			if (!isEnoent(error)) throw error;
		});
		removed += 1;
	}
	return removed;
}
