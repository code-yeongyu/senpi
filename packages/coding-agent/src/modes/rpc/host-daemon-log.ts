/**
 * The daemon log a fresh (generation 0) start would truncate is the replaced generation's only record of why it
 * stopped serving (senpi#4769). It is appended to `stderr.prev.log` first, never renamed over it, so a failed start
 * followed by a retry cannot overwrite the lines of the generation that was replaced; the file keeps its newest bytes.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { HostDaemonPaths } from "./host-daemon-paths.ts";

const PREVIOUS_LOG_MAX_BYTES = 1024 * 1024;

export async function keepPreviousDaemonLog(paths: Pick<HostDaemonPaths, "stderrLog" | "previousStderrLog">) {
	const current = await readOrEmpty(paths.stderrLog);
	if (current.length === 0) return;
	const marker = Buffer.from(`--- daemon log kept by a fresh start at ${new Date().toISOString()} ---\n`);
	const joined = Buffer.concat([await readOrEmpty(paths.previousStderrLog), marker, current]);
	await writeFile(paths.previousStderrLog, joined.subarray(Math.max(0, joined.length - PREVIOUS_LOG_MAX_BYTES)), {
		mode: 0o600,
	});
}

async function readOrEmpty(path: string): Promise<Buffer> {
	return readFile(path).catch((cause: unknown) => {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return Buffer.alloc(0);
		throw cause;
	});
}
