import { verify, type KeyObject } from "node:crypto";
import type { Duplex } from "node:stream";
import { isRecord } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import { attachJsonlLineReader } from "./jsonl.ts";
import { PRESENTER_EXCHANGE_MS, PRESENTER_PARKING_MS } from "./mcp-presenter-bootstrap.ts";

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

/**
 * Bound before parsing. Neither malformed bodies nor parser exceptions enter diagnostics. `"parked"`: the channel
 * waits up to `PRESENTER_PARKING_MS` for its first frame, and the exchange window starts with that frame.
 */
export function privateFrames(
	stream: Duplex,
	receive: (value: unknown) => void,
	deadline: boolean | "parked" = true,
): () => void {
	let parked = deadline === "parked";
	let timer =
		deadline === false
			? undefined
			: setTimeout(() => stream.destroy(), parked ? PRESENTER_PARKING_MS : PRESENTER_EXCHANGE_MS);
	const detach = attachJsonlLineReader(
		stream,
		(line) => {
			if (parked) {
				parked = false;
				clearTimeout(timer);
				timer = setTimeout(() => stream.destroy(), PRESENTER_EXCHANGE_MS);
			}
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
