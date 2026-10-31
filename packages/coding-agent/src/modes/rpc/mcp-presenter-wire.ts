import { verify, type KeyObject } from "node:crypto";
import type { Duplex } from "node:stream";
import { isRecord } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import { attachJsonlLineReader } from "./jsonl.ts";

export function signed(value: unknown, transcript: string, key: KeyObject): boolean {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 2 ||
		value.type !== "proof" ||
		typeof value.signature !== "string" ||
		!/^[a-f0-9]{128}$/.test(value.signature)
	)
		return false;
	return verify(null, Buffer.from(transcript), key, Buffer.from(value.signature, "hex"));
}

export function send(stream: Duplex, value: object): void {
	if (!stream.write(`${JSON.stringify(value)}\n`)) stream.destroy();
}

/** Bound before parsing. Neither malformed bodies nor parser exceptions enter diagnostics. */
export function privateFrames(stream: Duplex, receive: (value: unknown) => void, deadline = true): () => void {
	const timer = deadline ? setTimeout(() => stream.destroy(), 30_000) : undefined;
	const detach = attachJsonlLineReader(
		stream,
		(line) => {
			try {
				receive(JSON.parse(line));
			} catch {
				stream.destroy();
			}
		},
		{ maxLineLength: 16 * 1024, onOversizedLine: () => stream.destroy() },
	);
	stream.on("error", () => stream.destroy());
	stream.once("close", () => {
		clearTimeout(timer);
		detach();
	});
	return () => {
		clearTimeout(timer);
		detach();
	};
}
