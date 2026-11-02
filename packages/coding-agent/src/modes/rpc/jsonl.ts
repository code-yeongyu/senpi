import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * A legacy JSONL record nests deeper than this runtime's JSON engine can serialize (RULING-68). The legacy wire has no
 * protocol depth limit of its own: a record is refused only where `JSON.stringify` (or the recursive normaliser before
 * it) overflows the stack, and that refusal is this typed error instead of a `RangeError` that ends a worker or session.
 * It lives beside the serializer the lifecycle supervisor already loads, so the supervisor's import graph stays unchanged
 * (`test/supervisor-import-graph.test.ts`); the refusal bookkeeping stays in `legacy-record-depth.ts`.
 */
export class LegacyRecordDepthError extends Error {
	override readonly name = "LegacyRecordDepthError";
	readonly recordType: string;

	constructor(record: unknown, cause: RangeError) {
		const type = typeof record === "object" && record !== null ? Reflect.get(record, "type") : undefined;
		const recordType = typeof type === "string" ? type : "record";
		super(`${recordType} nests deeper than this runtime's JSON engine limit`, { cause });
		this.recordType = recordType;
	}
}

/** The engine's own stack overflow, as V8 and JavaScriptCore word it; any other `RangeError` is not a depth refusal. */
function isStackOverflow(cause: unknown): cause is RangeError {
	return cause instanceof RangeError && cause.message.startsWith("Maximum call stack size exceeded");
}

/** `JSON.stringify(value)` for the legacy wire: an engine stack overflow is a `LegacyRecordDepthError`. */
export function legacyJsonText(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch (cause) {
		if (isStackOverflow(cause)) throw new LegacyRecordDepthError(value, cause);
		throw cause;
	}
}

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only. A value past the engine's JSON depth limit throws the
 * typed `LegacyRecordDepthError` (RULING-68).
 */
export function serializeJsonLine(value: unknown): string {
	return `${legacyJsonText(value)}\n`;
}

export const MAX_RPC_LINE_CHARACTERS = 16 * 1024 * 1024;

export interface JsonlLineReaderOptions {
	maxLineLength?: number;
	onOversizedLine?: () => void;
}

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	options: JsonlLineReaderOptions = {},
): () => void {
	const decoder = new StringDecoder("utf8");
	const maxLineLength = options.maxLineLength ?? Number.POSITIVE_INFINITY;
	if (!(maxLineLength > 0)) throw new Error("maxLineLength must be greater than zero.");
	let buffer = "";
	let discardingOversizedLine = false;

	const consume = (text: string): void => {
		let offset = 0;
		while (offset < text.length) {
			if (discardingOversizedLine) {
				const newlineIndex = text.indexOf("\n", offset);
				if (newlineIndex === -1) return;
				discardingOversizedLine = false;
				offset = newlineIndex + 1;
				continue;
			}

			const newlineIndex = text.indexOf("\n", offset);
			if (newlineIndex === -1) {
				const remainder = text.slice(offset);
				if (buffer.length + remainder.length > maxLineLength) {
					buffer = "";
					discardingOversizedLine = true;
					options.onOversizedLine?.();
				} else {
					buffer += remainder;
				}
				return;
			}

			const segment = text.slice(offset, newlineIndex);
			if (buffer.length + segment.length > maxLineLength) {
				options.onOversizedLine?.();
			} else {
				const line = buffer + segment;
				onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
			}
			buffer = "";
			offset = newlineIndex + 1;
		}
	};

	const onData = (chunk: string | Buffer) => {
		consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
	};

	const onEnd = () => {
		consume(decoder.end());
		if (!discardingOversizedLine && buffer.length > 0) {
			onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
		}
		buffer = "";
		discardingOversizedLine = false;
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
