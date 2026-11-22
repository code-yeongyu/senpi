import { CompactWriteError } from "./compact-content-store.ts";

/**
 * The one protocol depth limit of the compact ingest boundary (senpi#4272 RULING-59 C). An incoming record is cloned
 * through native JSON before anything is owned, and native JSON recurses on nesting: Node 24 serializes at most 6,185
 * levels from a shallow stack (fewer under a deep one) and Bun 1.4 at most 40,000, and above that it throws an untyped
 * `RangeError`. A record nested deeper than this constant is refused before that clone.
 */
export const COMPACT_PROTOCOL_MAX_DEPTH = 1_024;

interface Frame {
	readonly container: object;
	readonly children: readonly unknown[];
	index: number;
}

/**
 * Refuses `value` when it nests more than `COMPACT_PROTOCOL_MAX_DEPTH` containers (`[[1]]` is 2 deep), walking it with
 * an explicit stack bounded by that limit, so the check itself never recurses. A cycle is refused as `cycle`.
 */
export function assertProtocolDepth(value: unknown): void {
	const stack: Frame[] = [];
	const ancestors = new Set<object>();
	const enter = (child: unknown): void => {
		if (typeof child !== "object" || child === null) return;
		if (ancestors.has(child)) throw new CompactWriteError("cycle");
		if (stack.length === COMPACT_PROTOCOL_MAX_DEPTH)
			throw new CompactWriteError("unsupported_value", COMPACT_PROTOCOL_MAX_DEPTH);
		ancestors.add(child);
		stack.push({ container: child, children: Array.isArray(child) ? child : Object.values(child), index: 0 });
	};
	enter(value);
	for (let top = stack.at(-1); top; top = stack.at(-1)) {
		if (top.index < top.children.length) enter(top.children[top.index++]);
		else {
			stack.pop();
			ancestors.delete(top.container);
		}
	}
}

export function protocolClone<T>(record: object): T {
	assertProtocolDepth(record);
	return JSON.parse(JSON.stringify(record));
}

/** The limit a depth refusal carries; undefined for every other failure, which ends the epoch's compact state. */
export function protocolDepthLimitOf(cause: unknown): number | undefined {
	return cause instanceof CompactWriteError ? cause.limit : undefined;
}

/** A worker's `canonical_unavailable` frame as the host lane's cause: its depth refusal is rebuilt typed. */
export function canonicalLoss(frame: { readonly reason: string; readonly limit?: number | undefined }): unknown {
	return frame.limit === undefined ? frame.reason : new CompactWriteError("unsupported_value", frame.limit);
}
