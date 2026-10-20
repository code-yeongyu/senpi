import type { Writable } from "node:stream";
import { appendDebugLogEntry } from "./hidden-stdout-log.ts";

const CLOSED_READER_CODES: ReadonlySet<string> = new Set(["EPIPE", "ECONNRESET"]);

/**
 * Attach before writing: a child that exits without reading its stdin fails the write as an "error" event on the
 * stream, and unhandled that is an uncaught EPIPE the crash handler reads as a dead terminal (oh-my-openagent#10623).
 * A closed reader is expected; any other failure goes to the debug log, never to the terminal or as a throw.
 */
export function guardChildStdin(stdin: Writable | null | undefined, context: string): void {
	stdin?.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== undefined && CLOSED_READER_CODES.has(error.code)) return;
		try {
			appendDebugLogEntry(`${context}: stdin write failed`, `${error.code ?? error.name}: ${error.message}`);
		} catch {}
	});
}
