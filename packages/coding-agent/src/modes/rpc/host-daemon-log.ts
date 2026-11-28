/**
 * The daemon log a fresh (generation 0) start would truncate is the replaced generation's only record of why it
 * stopped serving (senpi#4769). It is appended to `stderr.prev.log` first, never renamed over it, so a failed start
 * followed by a retry cannot overwrite the lines of the generation that was replaced; the file keeps its newest bytes.
 * Only the tails are read, so a log that grew for days costs at most `PREVIOUS_LOG_MAX_BYTES` of memory per file.
 * The kept log is diagnostics: failing to keep it never fails the start. The failure comes back as one line for the
 * start to write at the top of the new log, so it is recorded rather than lost.
 */
import { open, writeFile } from "node:fs/promises";
import type { HostDaemonPaths } from "./host-daemon-paths.ts";

const PREVIOUS_LOG_MAX_BYTES = 1024 * 1024;

export async function keepPreviousDaemonLog(
	paths: Pick<HostDaemonPaths, "stderrLog" | "previousStderrLog">,
): Promise<string | undefined> {
	return appendPreviousLog(paths).then(
		() => undefined,
		(cause: unknown) =>
			`senpi rpc host: the previous daemon log was not kept in ${paths.previousStderrLog}: ${cause instanceof Error ? cause.message : String(cause)}`,
	);
}

async function appendPreviousLog(paths: Pick<HostDaemonPaths, "stderrLog" | "previousStderrLog">): Promise<void> {
	const current = await readTail(paths.stderrLog);
	if (current.length === 0) return;
	const marker = Buffer.from(`--- daemon log kept by a fresh start at ${new Date().toISOString()} ---\n`);
	// The marker always fits; each log keeps its newest whole lines, so the file never opens mid-line or mid-character.
	const room = PREVIOUS_LOG_MAX_BYTES - marker.length;
	const kept = newestLines(current, room);
	const earlier = newestLines(await readTail(paths.previousStderrLog), room - kept.length);
	await writeFile(paths.previousStderrLog, Buffer.concat([earlier, marker, kept]), { mode: 0o600 });
}

/** The newest bytes of `log` within `limit`, starting at a line boundary when anything had to be cut. */
function newestLines(log: Buffer, limit: number): Buffer {
	if (log.length <= limit) return log;
	const lineEnd = log.indexOf(0x0a, log.length - limit - 1);
	return lineEnd === -1 ? Buffer.alloc(0) : log.subarray(lineEnd + 1);
}

async function readTail(path: string): Promise<Buffer> {
	const file = await open(path, "r").catch((cause: unknown) => {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
		throw cause;
	});
	if (file === undefined) return Buffer.alloc(0);
	try {
		const { size } = await file.stat();
		const length = Math.min(size, PREVIOUS_LOG_MAX_BYTES);
		const tail = Buffer.alloc(length);
		const { bytesRead } = await file.read(tail, 0, length, size - length);
		return tail.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
}
