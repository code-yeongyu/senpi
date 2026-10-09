import { writeSync } from "node:fs";

/**
 * A detached daemon exiting right after an async stderr.write to a file can lose the output
 * entirely; the supervisor writes synchronously so its diagnostics always land.
 */
export function writeStderrLine(text: string): void {
	try {
		writeSync(2, `${text}\n`);
	} catch {
		/* fd 2 unavailable: nothing more we can do. */
	}
}

export function supervisorLog(message: string): void {
	writeStderrLine(`senpi rpc host supervisor: ${message}`);
}

// Identity refusal loops share one process-local diagnostic budget, not a persisted latch.
const loggedUnknownIdentities = new Set<string>();

export function logUnknownHostIdentity(
	record: "legacy_host.pid" | "host.pid" | "session-path-claim",
	pid: number,
): void {
	const key = `${record}:${pid}`;
	if (loggedUnknownIdentities.has(key)) return;
	loggedUnknownIdentities.add(key);
	writeStderrLine(JSON.stringify({ event: "legacy_host_identity_unknown", record, pid }));
}

export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
