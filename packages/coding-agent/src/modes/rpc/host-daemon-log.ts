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
	const joined = Buffer.concat([await readTail(paths.previousStderrLog), marker, current]);
	await writeFile(paths.previousStderrLog, joined.subarray(Math.max(0, joined.length - PREVIOUS_LOG_MAX_BYTES)), {
		mode: 0o600,
	});
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
