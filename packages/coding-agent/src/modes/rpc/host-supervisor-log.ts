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

export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
