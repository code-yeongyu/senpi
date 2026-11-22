/** One open container: its children, whether it is an array, and the index of the next child to write. */
interface Frame {
	readonly entries: readonly (readonly [string, unknown])[] | readonly unknown[];
	readonly array: boolean;
	index: number;
}

/** Members `JSON.stringify` leaves out of an object. */
const SKIPPED = new Set(["undefined", "function", "symbol"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The text's size without building it: UTF-8 bytes (what a wire line costs) and UTF-16 code units (what is stored). */
export function jsonSize(value: unknown): { readonly bytes: number; readonly units: number } {
	let bytes = 0;
	let units = 0;
	for (const piece of walk(value)) {
		bytes += Buffer.byteLength(piece);
		units += piece.length;
	}
	return { bytes, units };
}

/** The pieces regrouped into chunks of exactly `size` code units (the last one shorter), whatever their own lengths. */
export function* jsonChunks(value: unknown, size: number): Generator<string> {
	let pending = "";
	for (const piece of walk(value)) {
		pending += piece;
		while (pending.length >= size) {
			yield pending.slice(0, size);
			pending = pending.slice(size);
		}
	}
	if (pending.length > 0) yield pending;
}

/**
 * A JSON-normal value (`normalizeJsonValue`'s output: plain objects, arrays, strings, finite numbers, booleans, null)
 * as the pieces of its `JSON.stringify` text, in order and without recursion, so the whole text is never one string:
 * concatenated, the pieces equal `JSON.stringify(value)` exactly (S13, RULING-81 X06). A string or key is one piece.
 */
function* walk(value: unknown): Generator<string> {
	const stack: Frame[] = [];
	let pending: { readonly value: unknown } | undefined = { value };
	for (;;) {
		if (pending) {
			const current = pending.value;
			pending = undefined;
			if (Array.isArray(current)) {
				yield "[";
				stack.push({ entries: current, array: true, index: 0 });
			} else if (isRecord(current)) {
				yield "{";
				const members = Object.entries(current).filter(([, child]) => !SKIPPED.has(typeof child));
				stack.push({ entries: members, array: false, index: 0 });
			} else yield JSON.stringify(current) ?? "null";
		}
		const frame = stack.at(-1);
		if (!frame) return;
		if (frame.index === frame.entries.length) {
			stack.pop();
			yield frame.array ? "]" : "}";
			continue;
		}
		if (frame.index > 0) yield ",";
		const entry = frame.entries[frame.index++];
		if (frame.array) pending = { value: entry };
		else {
			const [key, child] = entry as readonly [string, unknown];
			yield `${JSON.stringify(key)}:`;
			pending = { value: child };
		}
	}
}
