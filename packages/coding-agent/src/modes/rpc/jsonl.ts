import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isBigIntObject, isBooleanObject, isNumberObject, isStringObject } from "node:util/types";

/**
 * A stack overflow escaped the legacy writer's record path (RULING-68). `legacyJsonText` itself no longer overflows
 * (senpi#5702): this is the typed form of an overflow in any other recursive step a record passes, instead of a
 * `RangeError` that ends a worker or session.
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
export function isStackOverflow(cause: unknown): cause is RangeError {
	return cause instanceof RangeError && cause.message.startsWith("Maximum call stack size exceeded");
}

/** Marks a property `jsonNormalValue` leaves out (undefined, a function or a symbol in an object). */
const OMITTED: unique symbol = Symbol("omitted");

/**
 * One value after `JSON.stringify`'s per-value steps: `toJSON(key)`, primitive unboxing, number normalization, and the
 * BigInt refusal. Returns `OMITTED` for what an object drops (and an array writes as `null`), the scalar itself, or the
 * container still to be walked.
 */
function jsonStep(input: unknown, key: string): unknown {
	let value = input;
	if ((typeof value === "object" && value !== null) || typeof value === "function" || typeof value === "bigint") {
		const toJSON = (value as { toJSON?: (key: string) => unknown }).toJSON;
		if (typeof toJSON === "function") value = toJSON.call(value, key);
	}
	if (typeof value === "object" && value !== null) {
		if (isNumberObject(value)) value = +(value as unknown as number);
		else if (isStringObject(value)) value = String(value);
		else if (isBooleanObject(value)) value = Boolean.prototype.valueOf.call(value);
		else if (isBigIntObject(value)) throw new TypeError("Do not know how to serialize a BigInt");
	}
	if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
	if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return OMITTED;
	return value;
}

interface JsonFrame {
	readonly source: object;
	readonly out: unknown[] | Record<string, unknown>;
	/** An object's own enumerable keys, read once on entry like `JSON.stringify`; undefined for an array. */
	readonly keys: readonly string[] | undefined;
	readonly length: number;
	index: number;
}

/**
 * `JSON.parse(JSON.stringify(input))` with an explicit stack, so no nesting depth overflows it (senpi#5702). Every
 * getter, `toJSON` and `valueOf` runs once, in `JSON.stringify`'s depth-first order; a cycle and a BigInt throw the
 * same `TypeError`. Returns undefined where `JSON.stringify` returns undefined (an unrepresentable root).
 */
export function jsonNormalValue(input: unknown): unknown {
	const ancestors = new Set<object>();
	const stack: JsonFrame[] = [];
	/** The value a slot receives: a scalar, `OMITTED`, or the new container it was entered as. */
	const enter = (input: unknown, key: string): unknown => {
		const value = jsonStep(input, key);
		if (typeof value !== "object" || value === null) return value;
		if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
		ancestors.add(value);
		if (Array.isArray(value)) {
			const out: unknown[] = [];
			stack.push({ source: value, out, keys: undefined, length: value.length, index: 0 });
			return out;
		}
		const keys = Object.keys(value);
		const out: Record<string, unknown> = {};
		stack.push({ source: value, out, keys, length: keys.length, index: 0 });
		return out;
	};
	const root = enter(input, "");
	while (stack.length > 0) {
		const frame = stack[stack.length - 1] as JsonFrame;
		if (frame.index === frame.length) {
			ancestors.delete(frame.source);
			stack.pop();
			continue;
		}
		const index = frame.index++;
		if (frame.keys === undefined) {
			const child = enter((frame.source as unknown[])[index], String(index));
			(frame.out as unknown[]).push(child === OMITTED ? null : child);
			continue;
		}
		const name = frame.keys[index] as string;
		const child = enter((frame.source as Record<string, unknown>)[name], name);
		if (child !== OMITTED)
			Object.defineProperty(frame.out, name, { value: child, enumerable: true, configurable: true, writable: true });
	}
	return root === OMITTED ? undefined : root;
}

/** The JSON text of a value `jsonNormalValue` produced (plain arrays, plain objects and JSON scalars), without recursion. */
function normalJsonText(root: unknown): string {
	const parts: string[] = [];
	const stack: { readonly value: unknown[] | Record<string, unknown>; readonly keys?: string[]; index: number }[] = [];
	const open = (value: unknown): void => {
		if (typeof value !== "object" || value === null) parts.push(JSON.stringify(value));
		else if (Array.isArray(value)) {
			parts.push("[");
			stack.push({ value, index: 0 });
		} else {
			parts.push("{");
			stack.push({ value: value as Record<string, unknown>, keys: Object.keys(value), index: 0 });
		}
	};
	open(root);
	while (stack.length > 0) {
		const frame = stack[stack.length - 1] as (typeof stack)[number];
		const { keys } = frame;
		const length = keys === undefined ? (frame.value as unknown[]).length : keys.length;
		if (frame.index === length) {
			parts.push(keys === undefined ? "]" : "}");
			stack.pop();
			continue;
		}
		const index = frame.index++;
		if (index > 0) parts.push(",");
		if (keys === undefined) open((frame.value as unknown[])[index]);
		else {
			const name = keys[index] as string;
			parts.push(JSON.stringify(name), ":");
			open((frame.value as Record<string, unknown>)[name]);
		}
	}
	return parts.join("");
}

/**
 * `JSON.stringify(value)` for the legacy wire, at any nesting depth (senpi#5702). The native writer is the fast path;
 * only when the engine's own stack overflows does an explicit-stack writer with the same semantics produce the text, so
 * a record the native writer handles is byte-identical to before.
 */
export function legacyJsonText(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch (cause) {
		if (!isStackOverflow(cause)) throw cause;
		const normal = jsonNormalValue(value);
		return (normal === undefined ? undefined : normalJsonText(normal)) as string;
	}
}

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only. Any nesting depth serializes (senpi#5702).
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
