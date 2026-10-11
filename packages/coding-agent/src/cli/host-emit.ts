import { writeSync } from "node:fs";

/** One synchronous line, so a launcher exiting cannot truncate the caller's answer. */
export function emit(payload: Record<string, unknown>): void {
	writeSync(1, `${JSON.stringify(payload)}\n`);
}
