import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
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
