import { isStackOverflow, LegacyRecordDepthError } from "./jsonl.ts";
import { RPC_ERROR_RESPONSE_UNWRITABLE } from "./rpc-error-types.ts";
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

/** One line naming why a record could not be written. */
function causeLine(cause: unknown): string {
	const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
	return text.split("\n", 1)[0] ?? text;
}

/** The legacy records this writer refused or answered for, each reported once on stderr like other refusals. */
export class LegacyRecordRefusals {
	count = 0;

	report(sessionId: string, refusal: LegacyRecordDepthError): void {
		this.count += 1;
		process.stderr.write(`senpi rpc host: legacy record refused: ${refusal.message} (session ${sessionId})\n`);
	}

	reportReply(sessionId: string, command: string, cause: unknown): void {
		this.count += 1;
		process.stderr.write(
			`senpi rpc host: ${command} response unwritable (${causeLine(cause)}); answered ${RPC_ERROR_RESPONSE_UNWRITABLE} (session ${sessionId})\n`,
		);
	}
}

/** A reply record: what a caller is waiting for, keyed by its request `id`. */
function isReply(record: object): record is { type: "response"; id?: unknown; command?: unknown } {
	return Reflect.get(record, "type") === "response";
}

/**
 * The typed answer that replaces a reply that could not be written (senpi#5702): same `id` and `command`, so the caller
 * is answered instead of waiting for a line that never comes.
 */
function unwritableReply(record: { id?: unknown; command?: unknown }, cause: unknown): object {
	const command = typeof record.command === "string" ? record.command : "unknown";
	return {
		...(typeof record.id === "string" || typeof record.id === "number" ? { id: record.id } : {}),
		type: "response",
		command,
		success: false,
		error: `${command} response could not be written: ${causeLine(cause)}`,
		errorCode: RPC_ERROR_RESPONSE_UNWRITABLE,
	};
}

/**
 * Queues one session record on the legacy wire. A REPLY that cannot be written, for any reason, is answered with the
 * typed `response_unwritable` error for its id and reported (senpi#5702, LEAD ruling superseding RULING-68's "refused,
 * never delivered" for replies). Any other record whose path overflows the stack is refused and reported, never thrown:
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
		if (isReply(record)) {
			const answer = unwritableReply(record, cause);
			writer.legacyRefusals.reportReply(sessionId, Reflect.get(answer, "command") as string, cause);
			return writer.enqueue(sessionId, answer);
		}
		const refusal = isStackOverflow(cause) ? new LegacyRecordDepthError(record, cause) : cause;
		if (!(refusal instanceof LegacyRecordDepthError)) throw cause;
		writer.legacyRefusals.report(sessionId, refusal);
		return true;
	}
}
