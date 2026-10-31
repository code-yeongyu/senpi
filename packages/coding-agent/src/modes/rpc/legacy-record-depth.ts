import { LegacyRecordDepthError } from "./jsonl.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";

/**
 * True when the JSON `text` nests arrays and objects deeper than `limit` (the record itself is level 1), scanned without
 * recursion. A text of at most `2 * limit` characters cannot, so short records cost one length compare.
 */
export function jsonTextDeeperThan(text: string, limit: number): boolean {
	if (text.length <= 2 * limit) return false;
	let depth = 0;
	let inString = false;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (inString) {
			if (code === 0x5c) index++;
			else if (code === 0x22) inString = false;
		} else if (code === 0x22) inString = true;
		else if (code === 0x5b || code === 0x7b) {
			if (++depth > limit) return true;
		} else if (code === 0x5d || code === 0x7d) depth--;
	}
	return false;
}

/** The legacy records this writer refused at the engine limit, each reported once on stderr like other refusals. */
export class LegacyRecordRefusals {
	count = 0;

	report(sessionId: string, refusal: LegacyRecordDepthError): void {
		this.count += 1;
		process.stderr.write(`senpi rpc host: legacy record refused: ${refusal.message} (session ${sessionId})\n`);
	}
}

/**
 * Queues one session record on the legacy wire. A record past the engine limit is refused and reported, never thrown:
 * the session (and the worker carrying it) keeps running and the next record is delivered. Returns `enqueue`'s answer,
 * or true for a refused record, which is consumed (the session is neither closed nor over its output limit).
 */
export function enqueueLegacyRecord(
	writer: Pick<SessionEventWriter, "enqueue" | "legacyRefusals">,
	sessionId: string,
	record: object,
): boolean {
	try {
		return writer.enqueue(sessionId, record);
	} catch (cause) {
		if (!(cause instanceof LegacyRecordDepthError)) throw cause;
		writer.legacyRefusals.report(sessionId, cause);
		return true;
	}
}
