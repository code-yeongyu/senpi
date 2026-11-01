import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";

/**
 * An accepted end's settled ids: the message's `messageId` and the end's accepted sequence. A pending or failed terminal
 * pages them as the `message-<terminalSequence>` member; a joined message writes no terminal row and pages only its
 * `join-<n>` member's `messageId`.
 */
export interface TerminalIdentity {
	readonly messageId: string;
	readonly terminalSequence: number;
}

/**
 * RULING-120 (#5331): the ids the settled store records for one message, which a compact peer's own copy of the live
 * record carries too: an accepted end's terminal ids, a failed write's `messageId`, an entry join's `owningMessageId`
 * (the `messageId` of its `join-<n>` member).
 */
export type LiveIdentity = TerminalIdentity | { readonly messageId: string } | { readonly owningMessageId: string };

/** An end the settled store accepted: whether it joined the message to its durable entry, and the ids it recorded. */
export interface SettledEnd {
	readonly joined: boolean;
	readonly identity: TerminalIdentity;
}

/**
 * How many joined entries may wait for their `entry_appended` at once. Each normally arrives within a batch or two of
 * its append, so this only bounds entries whose `entry_appended` the lane never folds; the oldest is dropped first.
 */
export const MAX_PENDING_JOINS = 1024;

/**
 * One lane epoch's view of those ids for delivery: each joined entry's owning message, captured when its append is
 * applied and kept by entry id until that entry's `entry_appended` takes it (RULING-121, #5337), so transcript batches
 * applied in between cannot drop it; and the ids of the record it accepted last, answered only while that record, at
 * that sequence, is the one being delivered.
 */
export class MessageIdentities {
	private readonly joins = new Map<string, string>();
	private held: { readonly type: string; readonly sequence: number; readonly identity: LiveIdentity } | undefined;

	/** The epoch ended: nothing it joined or held can name a record delivered later. */
	reset(): void {
		this.joins.clear();
		this.held = undefined;
	}

	/** `owner`: the message the settled store joined this append to, the `messageId` of its `join-<n>` member. */
	joined(transition: TranscriptTransition, owner: string | undefined): void {
		if (owner === undefined || transition.kind !== "append") return;
		this.joins.set(transition.id, owner);
		if (this.joins.size <= MAX_PENDING_JOINS) return;
		const [oldest] = this.joins.keys();
		if (oldest !== undefined) this.joins.delete(oldest);
	}

	/** Every acceptance starts with nothing held, so a record the lane refuses never inherits its predecessor's ids. */
	clear(): void {
		this.held = undefined;
	}

	/** Holds the ids the settled store recorded for this record, or for an `entry_appended`, its entry's join (taken). */
	hold(type: string, sequence: number, record: object, recorded: LiveIdentity | undefined): void {
		const identity = recorded ?? (type === "entry_appended" ? this.takeEntryOwner(record) : undefined);
		if (identity) this.held = { type, sequence, identity };
	}

	of(type: unknown, sequence: number): LiveIdentity | undefined {
		const held = this.held;
		return held && held.type === type && held.sequence === sequence ? held.identity : undefined;
	}

	private takeEntryOwner(record: object): LiveIdentity | undefined {
		const entryId: unknown = Reflect.get(Object(Reflect.get(record, "entry")), "id");
		if (typeof entryId !== "string") return undefined;
		const owningMessageId = this.joins.get(entryId);
		this.joins.delete(entryId);
		return owningMessageId === undefined ? undefined : { owningMessageId };
	}
}
