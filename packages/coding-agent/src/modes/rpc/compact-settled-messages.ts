import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";
import { CompactContentIndex, type FrozenIndex } from "./compact-content-index.ts";
import {
	COMPACT_LEAF_CODE_UNITS,
	CompactContentStore,
	type CompactContentStoreOptions,
	type LeafId,
} from "./compact-content-store.ts";

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
	readonly runtimeItemKey: null;
	readonly entryId: null;
	readonly status: "pending" | "failed";
	readonly error: { readonly errorMessage: string } | null;
	readonly payload: readonly LeafId[];
}

export interface OwnerRow {
	readonly kind: "owner";
	readonly messageId: string;
	readonly entryId: string;
}

type Row = TerminalRow | OwnerRow | { readonly kind: "ended" };
export type SettledRoot = FrozenIndex;

/** One spillable collection owns payloads, end markers and both directions of the durable join. */
export class CompactSettledMessages {
	private readonly store: CompactContentStore;
	private readonly rows: CompactContentIndex<Row>;
	/** Resident membership of the paged rows, the synchronous check acceptance needs (pruning: carried item 9). */
	private readonly keys = new Set<string>();
	private readonly epoch: string;
	private readonly diagnose: (reason: SettledDiagnostic) => void;

	constructor(epoch: string, options: CompactContentStoreOptions, diagnose: (reason: SettledDiagnostic) => void) {
		this.epoch = epoch;
		this.diagnose = diagnose;
		this.store = new CompactContentStore(options);
		this.rows = new CompactContentIndex(this.store, (row) => (row.kind === "terminal" ? row.payload : []), 128);
	}

	valid(carrier: RecoveryCarrier | undefined): carrier is RecoveryCarrier {
		return carrier !== undefined && carrier.epoch === this.epoch;
	}

	end(record: object, carrier: RecoveryCarrier | undefined, sequence: number, turnId: string | null): void {
		if (!this.valid(carrier)) return this.diagnose("unknown_message");
		const id = carrier.messageId;
		if (this.keys.has(`end:${id}`)) return this.diagnose("duplicate_end");
		if (carrier.durableEntryId && !this.keys.has(`owner:${id}`)) {
			if (this.keys.has(`entry:${carrier.durableEntryId}`)) return this.diagnose("conflicting_owner");
			this.join(id, carrier.durableEntryId);
		}
		this.put(`end:${id}`, { kind: "ended" });
		if (this.keys.has(`owner:${id}`)) return;
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
		this.put(`terminal:${id}`, {
			kind: "terminal",
			messageId: id,
			turnId,
			terminalSequence: sequence,
			role,
			runtimeItemKey: null,
			entryId: null,
			status: "pending",
			error: null,
			payload,
		});
		for (const leaf of payload) this.store.adjust(leaf, -1, 0);
		if (!["user", "assistant", "toolResult", "custom"].includes(role)) this.diagnose("unsupported_role");
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
		if (this.keys.has(`owner:${id}`) || this.keys.has(`entry:${transition.id}`))
			return this.diagnose("conflicting_owner");
		this.join(id, transition.id);
	}

	private join(messageId: string, entryId: string): void {
		const owner: OwnerRow = { kind: "owner", messageId, entryId };
		this.put(`owner:${messageId}`, owner);
		this.put(`entry:${entryId}`, owner);
		this.rows.delete(`terminal:${messageId}`);
		this.keys.delete(`terminal:${messageId}`);
	}

	private put(key: string, row: Row): void {
		this.rows.set(key, row);
		this.keys.add(key);
	}

	freeze(): SettledRoot {
		return this.rows.freeze();
	}

	release(root: SettledRoot): void {
		this.rows.release(root);
	}

	async read(root: SettledRoot) {
		const settledMessages: (Omit<TerminalRow, "kind" | "payload"> & { terminal: unknown; correlation: unknown })[] =
			[];
		const owners: OwnerRow[] = [];
		for (const [key, row] of await this.rows.entries(root)) {
			if (row.kind === "owner" && key.startsWith("owner:")) owners.push(row);
			if (row.kind !== "terminal") continue;
			const { payload, kind: _kind, ...fields } = row;
			const bytes = (await Promise.all(payload.map((leaf) => this.store.readLeaf(leaf)))).join("");
			const value: { terminal: unknown; correlation: unknown } = JSON.parse(bytes);
			settledMessages.push({ ...fields, ...value });
		}
		return { settledMessages, owners };
	}

	storageStatus() {
		return { ...this.store.status(), ...this.rows.status() };
	}

	idle(): Promise<void> {
		return this.store.idle();
	}

	retire(): Promise<void> {
		return this.store.retire();
	}
}
