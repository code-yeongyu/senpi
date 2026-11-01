import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";

/** What an accepted end's terminal row records: the settled `message-<terminalSequence>` member's own ids. */
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
 * One lane epoch's view of those ids for delivery: the entries its last transcript batch joined (an `entry_appended`
 * arrives right after the batch that journaled its append) and the ids of the record it accepted last, answered only
 * while that record, at that sequence, is the one being delivered.
 */
export class MessageIdentities {
	private joins = new Map<string, string>();
	private held: { readonly type: string; readonly sequence: number; readonly identity: LiveIdentity } | undefined;

	/** A new transcript batch: the previous batch's joins can no longer name a record that arrives now. */
	batch(): void {
		this.joins = new Map();
	}

	joined(transition: TranscriptTransition, owner: string | undefined): void {
		if (owner !== undefined && transition.kind === "append") this.joins.set(transition.id, owner);
	}

	/** Every acceptance starts with nothing held, so a record the lane refuses never inherits its predecessor's ids. */
	clear(): void {
		this.held = undefined;
	}

	/** Holds the ids the settled store recorded for this record, or for an `entry_appended`, its entry's join. */
	hold(type: string, sequence: number, record: object, recorded: LiveIdentity | undefined): void {
		const identity = recorded ?? (type === "entry_appended" ? this.entryOwner(record) : undefined);
		if (identity) this.held = { type, sequence, identity };
	}

	of(type: unknown, sequence: number): LiveIdentity | undefined {
		const held = this.held;
		return held && held.type === type && held.sequence === sequence ? held.identity : undefined;
	}

	private entryOwner(record: object): LiveIdentity | undefined {
		const entryId: unknown = Reflect.get(Object(Reflect.get(record, "entry")), "id");
		const owningMessageId = typeof entryId === "string" ? this.joins.get(entryId) : undefined;
		return owningMessageId === undefined ? undefined : { owningMessageId };
	}
}
