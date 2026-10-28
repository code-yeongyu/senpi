import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";
import type { CallProjection } from "./compact-call-model.ts";
import { CompactContentIndex, type FrozenIndex, type IndexCursor } from "./compact-content-index.ts";
import {
	COMPACT_LEAF_CODE_UNITS,
	CompactContentStore,
	type CompactContentStoreOptions,
	type LeafId,
} from "./compact-content-store.ts";
import { assertProtocolDepth } from "./compact-protocol-depth.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { CompactValues, ValueRef } from "./compact-values.ts";

export type SettledDiagnostic =
	| "unknown_message"
	| "duplicate_end"
	| "retired_owner"
	| "conflicting_owner"
	| "unsupported_role";

export interface TerminalRow {
	readonly kind: "terminal";
	readonly messageId: string;
	readonly turnId: string | null;
	readonly terminalSequence: number;
	readonly role: string;
	/** A toolResult row carries the key of the call it retired (RULING-13 Q7); every other row has none. */
	readonly runtimeItemKey: string | null;
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

type Row = TerminalRow | OwnerRow;
export type SettledRoot = FrozenIndex;
/** One row of a cut as the catalog enumerates it: a terminal with its paged call, or one message's entry join. */
type SettledMember = { readonly kind: "terminal"; readonly row: TerminalRow } | OwnerRow;
/** The bounded reads of one cut of this store (S10b): its rows a page at a time, its leaves, its values, its joins. */
export interface SettledReader {
	readonly store: CompactContentStore;
	readonly values: CompactValues;
	members(valid: () => void): AsyncGenerator<SettledMember>;
	messageOf(entryId: string): Promise<string | null>;
}

const isProjection = (value: unknown): value is CallProjection =>
	typeof value === "object" && value !== null && typeof Reflect.get(value, "runtimeItemKey") === "string";

/** One spillable collection owns payloads, end markers and both directions of the durable join. */
export class CompactSettledMessages {
	private readonly store: CompactContentStore;
	private readonly rows: CompactContentIndex<Row>;
	/**
	 * Resident membership: one state key per message (`end:` ended but unjoined, `owner:` -> entry id joined before its
	 * end, `settled:` -> entry id both), `terminal:` per pending terminal row and `entry:` per joined entry. Settling a
	 * message folds its end marker into its join and drops its terminal row, so what a settled message keeps resident is
	 * exactly the two id-sized facts the duplicate-end and conflicting-owner checks need (carried item 9, senpi#4460):
	 * residency is O(settled messages) per epoch, two id keys per message, payloads zero. Bounding it independently of
	 * message count needs a paged synchronous membership filter, carried to S08/S11 (RULING-48 item 9).
	 */
	private readonly keys = new Map<string, string>();
	private readonly epoch: string;
	private readonly diagnose: (reason: SettledDiagnostic) => void;

	constructor(epoch: string, options: CompactContentStoreOptions, diagnose: (reason: SettledDiagnostic) => void) {
		this.epoch = epoch;
		this.diagnose = diagnose;
		this.store = new CompactContentStore(options);
		this.rows = new CompactContentIndex(
			this.store,
			(row) => (row.kind === "terminal" ? [...row.payload, row.call?.owner ?? 0] : []),
			128,
		);
	}

	/** The catalog's reader of one cut: rows a page at a time, payload leaves, paged values and entry joins. */
	reader(root: SettledRoot): SettledReader {
		return {
			store: this.store,
			values: this.rows.values,
			members: (valid) => this.members(root, valid),
			messageOf: (entryId) => this.messageOf(root, entryId),
		};
	}

	valid(carrier: RecoveryCarrier | undefined): carrier is RecoveryCarrier {
		return carrier !== undefined && carrier.epoch === this.epoch;
	}

	/**
	 * Returns whether this end joined the message to its durable entry: the only end that settles persistence. `call`:
	 * the projection of the outstanding call this toolResult settles, stored with the terminal (Q2). The terminal is
	 * serialized from `record`, so a record over the protocol depth limit is refused typed before anything changes
	 * (RULING-59 C); the lane runs that check, and counts the refusal, before it calls this.
	 */
	end(
		record: object,
		carrier: RecoveryCarrier | undefined,
		sequence: number,
		turnId: string | null,
		call?: CallProjection,
	): boolean {
		assertProtocolDepth(record);
		if (!this.valid(carrier)) return this.reject("unknown_message");
		const id = carrier.messageId;
		if (this.keys.has(`end:${id}`) || this.keys.has(`settled:${id}`)) return this.reject("duplicate_end");
		const owned = this.keys.get(`owner:${id}`);
		if (carrier.durableEntryId && owned !== undefined && owned !== carrier.durableEntryId)
			return this.reject("conflicting_owner");
		let joined = false;
		if (carrier.durableEntryId && owned === undefined) {
			if (this.keys.has(`entry:${carrier.durableEntryId}`)) return this.reject("conflicting_owner");
			this.join(id, carrier.durableEntryId);
			joined = true;
		}
		if (this.keys.has(`owner:${id}`)) {
			this.settle(id);
			return joined;
		}
		this.keys.set(`end:${id}`, "");
		const message: unknown = Reflect.get(record, "message");
		const role = String(Reflect.get(Object(message), "role"));
		const payload: LeafId[] = [];
		const text = JSON.stringify({
			terminal: message,
			correlation: {
				clientMessageId: Reflect.get(record, "clientMessageId"),
				clientTurnId: Reflect.get(record, "clientTurnId"),
				clientMessages: Reflect.get(record, "clientMessages"),
			},
		});
		for (let offset = 0; offset < text.length; offset += COMPACT_LEAF_CODE_UNITS)
			payload.push(this.store.createLeaf(text.slice(offset, offset + COMPACT_LEAF_CODE_UNITS)));
		const projection = call ? this.rows.values.own(call) : null;
		this.put(`terminal:${id}`, {
			kind: "terminal",
			messageId: id,
			turnId,
			terminalSequence: sequence,
			role,
			runtimeItemKey: call?.runtimeItemKey ?? null,
			entryId: null,
			status: "pending",
			error: null,
			payload,
			call: projection,
		});
		for (const leaf of payload) this.store.adjust(leaf, -1, 0);
		if (projection) this.store.adjust(projection.owner, -1, 0);
		if (!["user", "assistant", "toolResult", "custom"].includes(role)) this.diagnose("unsupported_role");
		return false;
	}

	private reject(reason: SettledDiagnostic): false {
		this.diagnose(reason);
		return false;
	}

	fail(carrier: RecoveryCarrier | undefined, errorMessage: string): void {
		if (!this.valid(carrier) || !this.keys.has(`terminal:${carrier.messageId}`))
			return this.diagnose("unknown_message");
		this.rows.patch(`terminal:${carrier.messageId}`, { status: "failed", error: { errorMessage } });
	}

	append(transition: Extract<TranscriptTransition, { kind: "append" }>): void {
		const id = transition.owningMessageId;
		if (id === undefined) return;
		if (transition.recoveryEpoch !== this.epoch) return this.diagnose("retired_owner");
		if (this.keys.has(`owner:${id}`) || this.keys.has(`settled:${id}`) || this.keys.has(`entry:${transition.id}`))
			return this.diagnose("conflicting_owner");
		this.join(id, transition.id);
	}

	private join(messageId: string, entryId: string): void {
		const owner: OwnerRow = { kind: "owner", messageId, entryId };
		this.put(`owner:${messageId}`, owner);
		this.put(`entry:${entryId}`, owner);
		this.rows.delete(`terminal:${messageId}`);
		this.keys.delete(`terminal:${messageId}`);
		this.keys.set(`owner:${messageId}`, entryId);
		if (this.keys.has(`end:${messageId}`)) this.settle(messageId);
	}

	/** Ended and joined: its rows stay paged; its end marker folds into its join, its entry stays claimed. */
	private settle(messageId: string): void {
		this.keys.set(`settled:${messageId}`, this.keys.get(`owner:${messageId}`) ?? "");
		this.keys.delete(`owner:${messageId}`);
		this.keys.delete(`end:${messageId}`);
	}

	private put(key: string, row: Row): void {
		this.rows.set(key, row);
		this.keys.set(key, "");
	}

	/** The message each entry joined in this epoch, read in order from one cut of the paged rows; undefined for none. */
	async messagesOf(entryIds: readonly string[]): Promise<(string | undefined)[]> {
		const cut = this.rows.freeze();
		try {
			const ids: (string | undefined)[] = [];
			for (const entryId of entryIds) ids.push((await this.messageOf(cut, entryId)) ?? undefined);
			return ids;
		} finally {
			this.rows.release(cut);
		}
	}

	freeze(): SettledRoot {
		return this.rows.freeze();
	}

	release(root: SettledRoot): void {
		this.rows.release(root);
	}

	async read(root: SettledRoot) {
		const settledMessages: (Omit<TerminalRow, "kind" | "payload" | "call"> & {
			terminal: unknown;
			correlation: unknown;
			call?: CallProjection;
		})[] = [];
		const owners: OwnerRow[] = [];
		for (const [key, row] of await this.rows.entries(root)) {
			if (row.kind === "owner" && key.startsWith("owner:")) owners.push(row);
			if (row.kind !== "terminal") continue;
			const { payload, kind: _kind, call, ...fields } = row;
			const bytes = (await Promise.all(payload.map((leaf) => this.store.readLeaf(leaf)))).join("");
			const value: { terminal: unknown; correlation: unknown } = JSON.parse(bytes);
			const projection = call ? await this.rows.values.read(call) : undefined;
			if (projection !== undefined && !isProjection(projection)) throw new CompactReadError("ownership");
			settledMessages.push({ ...fields, ...value, ...(projection ? { call: projection } : {}) });
		}
		return { settledMessages, owners };
	}

	/**
	 * The rows of one cut, a descriptor page (at most 128) at a time (S10b): each terminal row with its patched status
	 * and the ref of its paged call, each `owner:` join once (its `entry:` twin is the same row). A reader of a terminal's
	 * payload or call pages through `readLeaf` and `values.walk` under the same cut.
	 */
	private async *members(root: SettledRoot, valid: () => void): AsyncGenerator<SettledMember> {
		let cursor: IndexCursor | undefined;
		do {
			const page = await this.rows.page(root, cursor);
			for (const { row, patch } of page.rows) {
				valid();
				const key = await this.rows.values.read(row.key);
				if (typeof key !== "string" || key.startsWith("entry:")) continue;
				const stored: Row = JSON.parse(JSON.stringify(await this.rows.values.read(row.value)));
				if (stored.kind === "owner") {
					yield stored;
					continue;
				}
				const patched: Partial<TerminalRow> = patch
					? JSON.parse(JSON.stringify(await this.rows.values.read(patch)))
					: {};
				yield { kind: "terminal", row: { ...stored, ...patched } };
			}
			cursor = page.next;
		} while (cursor);
	}

	/** The message an entry joined in this cut, if any (the `source` family's join). */
	private async messageOf(root: SettledRoot, entryId: string): Promise<string | null> {
		const row = await this.rows.lookup(root, `entry:${entryId}`);
		const owner: unknown = row && (await this.rows.values.read(row.value));
		const messageId: unknown = owner ? Reflect.get(Object(owner), "messageId") : null;
		return typeof messageId === "string" ? messageId : null;
	}

	storageStatus() {
		return { ...this.store.status(), ...this.rows.status(), residentSettledKeys: this.keys.size };
	}

	idle(): Promise<void> {
		return this.store.idle();
	}

	retire(): Promise<void> {
		return this.store.retire();
	}
}
