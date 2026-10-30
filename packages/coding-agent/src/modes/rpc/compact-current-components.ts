import { CompactComponentRoots, type ComponentRoot } from "./compact-component-roots.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import { CompactValues, type ValueRef } from "./compact-values.ts";

export type CompactRunState = "idle" | "running";

/**
 * One open dialog as a cut holds it. A broadcast question keeps its request, which a late peer may be shown; a targeted
 * dialog keeps only its identity, method and deadline, so no reader of a cut can present it (RULING-25 Q4).
 */
export interface CompactDialog {
	readonly id: string;
	readonly audience: "broadcast" | "targeted";
	readonly method: string;
	readonly deadlineAtMs?: number;
	readonly request?: object;
}

export interface FrozenComponents {
	readonly runState: CompactRunState;
	readonly lifecycle: ValueRef | undefined;
	readonly dialogs: ValueRef | undefined;
	readonly dialogCounts: { readonly broadcast: number; readonly targeted: number };
}

/** The host-origin records that change lifecycle, run state or dialogs; each folds at its own lane sequence. */
export const COMPONENT_RECORDS: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"session_lifecycle",
	"extension_ui_request",
	"question_updated",
	"question_resolved",
	"ui_request_settled",
]);
const TARGETED = new Set(["select", "confirm", "input", "editor"]);

const field = (record: object, key: string): unknown => Reflect.get(record, key);
const deadline = (record: object) => {
	const value = field(record, "deadlineAtMs");
	return typeof value === "number" ? { deadlineAtMs: value } : {};
};

/**
 * Run state, the latest lifecycle description and the open dialogs of one epoch (S03b-3b, RULING-26 Q4): current
 * values only, never a log of notifications. Each change replaces a persistent root; a cut pins the roots it froze.
 */
export class CompactCurrentComponents {
	private runState: CompactRunState = "idle";
	private lifecycle: ValueRef | undefined;
	private dialogs: ComponentRoot<CompactDialog> = { header: undefined, ref: undefined };
	private readonly open = new Map<string, { readonly order: string; readonly dialog: CompactDialog }>();
	private opened = 0;
	private readonly store: CompactContentStore;
	private readonly values: CompactValues;
	private readonly dialogRoots: CompactComponentRoots<CompactDialog>;

	constructor(store: CompactContentStore) {
		this.store = store;
		this.values = new CompactValues(store);
		this.dialogRoots = new CompactComponentRoots(store, () => []);
	}

	get openBroadcast(): number {
		let count = 0;
		for (const { dialog } of this.open.values()) if (dialog.audience === "broadcast") count++;
		return count;
	}

	/** `record` is JSON-normal (the acceptance unit's producer boundary). */
	apply(record: object): void {
		switch (field(record, "type")) {
			case "agent_start":
			case "agent_end":
				this.runState = field(record, "type") === "agent_start" ? "running" : "idle";
				return;
			case "session_lifecycle": {
				const next = this.values.own(record);
				if (this.lifecycle) this.store.adjust(this.lifecycle.owner, -1, 0);
				this.lifecycle = next;
				return;
			}
			case "extension_ui_request": {
				const id = field(record, "id");
				const method = String(field(record, "method"));
				if (typeof id !== "string" || (method !== "question" && !TARGETED.has(method)) || this.open.has(id)) return;
				const broadcast = method === "question";
				const dialog: CompactDialog = {
					id,
					audience: broadcast ? "broadcast" : "targeted",
					method,
					...deadline(record),
					...(broadcast ? { request: record } : {}),
				};
				return this.put(id, String(this.opened++).padStart(16, "0"), dialog);
			}
			case "question_updated": {
				const id = String(field(record, "id"));
				const open = this.open.get(id);
				if (open) this.put(id, open.order, { ...open.dialog, ...deadline(record) });
				return;
			}
			default: {
				const id = String(field(record, "id") ?? field(record, "uiRequestId"));
				const open = this.open.get(id);
				if (!open) return;
				this.dialogs = this.dialogRoots.set(this.dialogs, open.order, undefined);
				this.open.delete(id);
			}
		}
	}

	freeze(): FrozenComponents {
		for (const ref of [this.lifecycle, this.dialogs.ref]) if (ref) this.store.adjust(ref.owner, 0, 1);
		const broadcast = this.openBroadcast;
		return {
			runState: this.runState,
			lifecycle: this.lifecycle,
			dialogs: this.dialogs.ref,
			dialogCounts: { broadcast, targeted: this.open.size - broadcast },
		};
	}

	release(frozen: FrozenComponents): void {
		for (const ref of [frozen.lifecycle, frozen.dialogs]) if (ref) this.store.adjust(ref.owner, 0, -1);
	}

	/** The cut's components; dialogs in the order they opened. Called under the cut's operation lease. */
	async read(frozen: FrozenComponents, valid: () => void) {
		const lifecycle = frozen.lifecycle ? await this.values.read(frozen.lifecycle) : null;
		valid();
		const dialogs: CompactDialog[] = [];
		for await (const [, dialog] of this.dialogRoots.entries(frozen.dialogs, valid)) dialogs.push(dialog);
		return { runState: frozen.runState, lifecycle, dialogs, dialogCounts: frozen.dialogCounts };
	}

	private put(id: string, order: string, dialog: CompactDialog): void {
		this.dialogs = this.dialogRoots.set(this.dialogs, order, dialog);
		this.open.set(id, { order, dialog });
	}
}
