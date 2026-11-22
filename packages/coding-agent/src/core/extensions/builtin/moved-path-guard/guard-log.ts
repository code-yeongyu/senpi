import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../../config.ts";

export type GuardLogEvent = "breadcrumb_ignored" | "marker_newer" | "call_bound_reached";

/** The log rotates once to `<file>.1` before it would pass this size, so it holds at most about twice this. */
export const MAX_GUARD_LOG_BYTES = 1024 * 1024;

const reported = new Set<string>();
let pending: Promise<void> = Promise.resolve();

export function guardLogPath(): string {
	return join(getAgentDir(), "logs", "moved-path-guard.log");
}

async function append(line: string): Promise<void> {
	const file = guardLogPath();
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const size = await stat(file).then(
		(stats) => stats.size,
		() => 0,
	);
	if (size + Buffer.byteLength(line) > MAX_GUARD_LOG_BYTES) await rename(file, `${file}.1`);
	await appendFile(file, line, { mode: 0o600 });
}

/**
 * One JSON line per distinct event and reason, written asynchronously and in order (senpi#2898): the guard runs on the
 * session loop, so it never writes synchronously, and nothing about logging (not even computing where the log lives)
 * can throw into the caller; a failure only loses diagnostics. A `count` detail does not make an event distinct.
 */
export function logGuardEvent(level: "debug" | "warn", event: GuardLogEvent, details: Record<string, string>): void {
	const { count: _count, ...reason } = details;
	const key = `${event}\0${JSON.stringify(reason)}`;
	if (reported.has(key)) return;
	reported.add(key);
	const line = `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...details })}\n`;
	pending = pending.then(() => append(line)).catch(() => undefined);
}

export function flushGuardLog(): Promise<void> {
	return pending;
}
