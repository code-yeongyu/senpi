import type { CallProjection } from "./compact-call-model.ts";
import type { CompactContentStore, LeafId } from "./compact-content-store.ts";
import type { CompactValues, ValueRef } from "./compact-values.ts";

export interface TerminalRow {
	readonly kind: "terminal";
	readonly messageId: string;
	readonly turnId: string | null;
	readonly terminalSequence: number;
	readonly role: string;
	/** A toolResult row carries the key of the call it retired (RULING-13 Q7); every other row has none. */
	readonly runtimeItemKey: string | null;
	/** The retired call's `callUnknown` mark (#5348): this carrier was joined to that call by order. */
	readonly callUnknown?: true;
	readonly entryId: null;
	readonly status: "pending" | "failed";
	readonly error: { readonly errorMessage: string } | null;
	readonly payload: readonly LeafId[];
	/**
	 * The retired call's projection as paged value pages (RULING-60 Q3): every nested `calls` array is pages of at most
	 * 128 child descriptors and 64 KiB, recursively, so no child count is ever truncated and a reader walks it with one
	 * page resident.
	 */
	readonly call: ValueRef | null;
}

export interface OwnerRow {
	readonly kind: "owner";
	readonly messageId: string;
	readonly entryId: string;
}

/** A join as stored: its row and the epoch-local ordinal it was joined at, the identity member's stable id. */
export interface StoredOwner extends OwnerRow {
	readonly ordinal: number;
}

export type SettledRow = TerminalRow | StoredOwner;
/** One row of a cut as the catalog enumerates it: a terminal with its paged call, or one message's entry join. */
export type SettledMember = { readonly kind: "terminal"; readonly row: TerminalRow } | StoredOwner;
/** The bounded reads of one cut of the settled store (S10b): its rows a page at a time, its leaves, values, joins. */
export interface SettledReader {
	readonly store: CompactContentStore;
	readonly values: CompactValues;
	members(valid: () => void): AsyncGenerator<SettledMember>;
	messageOf(entryId: string): Promise<string | null>;
}

export const isProjection = (value: unknown): value is CallProjection =>
	typeof value === "object" && value !== null && typeof Reflect.get(value, "runtimeItemKey") === "string";
