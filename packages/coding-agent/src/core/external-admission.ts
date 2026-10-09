/**
 * Atomic, idempotent admission of a message another session sent this one.
 *
 * One synchronous call decides and acts: a delivery either enters the runtime (a started turn, the
 * follow-up queue or the steering queue - the same queues a user's queued input uses) exactly once,
 * or nothing happens. The ledger is the process-lifetime answer to "does this runtime hold, or has it
 * written, delivery X": a delivery is `pending` from admission until its transcript entry is
 * persisted, then `emitted`. A second admission of an id in either state is `already_admitted`.
 * A delivery whose entry the session file refused is `failed` (with the error): it is no longer held,
 * so it blocks nothing, and it stays with its sender. It is admitted again only once the run that
 * refused it has settled and the file's last write succeeded: a redelivery then starts or joins a
 * later run, whose start drops the refused copy from the model context, and it never loops against
 * a file that still refuses writes.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AdmissionHoldReason,
	type AdmitExternalMessageInput,
	type AdmittedDeliveries,
	type ExternalAdmissionResult,
	type ExternalDeliverAs,
	isSessionControlDeliveryDetails,
	SESSION_CONTROL_DELIVERY_TYPE,
	type SessionAdmissionGate,
	type SessionControlDeliveryDetails,
} from "./extensions/session-control-types.ts";
import type { CustomMessage } from "./messages.ts";

export type SessionControlDeliveryMessage = CustomMessage<SessionControlDeliveryDetails>;

export interface ExternalAdmissionPort {
	/** A run is active, or a prompt has claimed its start: new input queues behind it. */
	readonly isBusy: () => boolean;
	/** Synchronously enqueues into the runtime's own queue for `lane`. */
	readonly enqueue: (message: SessionControlDeliveryMessage, lane: ExternalDeliverAs) => void;
	/** Starts a turn carrying `message`; settles when that run is over, whether or not it wrote the entry. */
	readonly start: (message: SessionControlDeliveryMessage) => Promise<void>;
}

export interface EditorHoldState {
	readonly hold_reason?: AdmissionHoldReason;
	readonly revision: number;
}

type PendingLane = ExternalDeliverAs | "start";

export class ExternalAdmission {
	private turnEpochValue = 0;
	private readonly pending = new Map<string, PendingLane>();
	private readonly emitted = new Set<string>();
	private readonly failed = new Map<string, string>();
	private fileTakesWrites = true;
	private readonly emittedListeners = new Set<(deliveryId: string) => void>();
	private editorSource: (() => EditorHoldState) | undefined;
	private closedReason: string | undefined;
	private readonly port: ExternalAdmissionPort;
	private readonly inputHolds = new Set<InputHoldState>();
	private readonly settledListeners = new Set<() => void>();

	constructor(port: ExternalAdmissionPort) {
		this.port = port;
	}

	get turnEpoch(): number {
		return this.turnEpochValue;
	}

	/** Called when an agent run begins; a steer names the epoch it was meant for. */
	beginTurn(): void {
		this.turnEpochValue += 1;
	}

	/** The composer whose draft holds admissions; `undefined` detaches it (no composer = never held). */
	setEditorSource(source: (() => EditorHoldState) | undefined): void {
		this.editorSource = source;
	}

	/**
	 * Holds admission while user input is on its way into the runtime: from `prompt()` entry until the
	 * prompt reports a disposition or returns. A `command` hold (an extension or built-in command that
	 * may submit text after an await) also ends as soon as a prompt the command submitted - one from
	 * an extension (`submittedByCommand`) that began while it was open - is accepted. Ending a hold is
	 * idempotent; the last one to end notifies `onInputsSettled`.
	 */
	beginInput(options: { readonly command?: boolean; readonly submittedByCommand?: boolean } = {}): InputHold {
		const parents = options.submittedByCommand ? [...this.inputHolds].filter((hold) => hold.command) : [];
		const state: InputHoldState = { command: options.command === true };
		this.inputHolds.add(state);
		const end = (): void => this.endHold(state);
		return {
			accepted: () => {
				end();
				for (const parent of parents) this.endHold(parent);
			},
			end,
		};
	}

	onInputsSettled(listener: () => void): () => void {
		this.settledListeners.add(listener);
		return () => this.settledListeners.delete(listener);
	}

	onEmitted(listener: (deliveryId: string) => void): () => void {
		this.emittedListeners.add(listener);
		return () => this.emittedListeners.delete(listener);
	}

	/**
	 * From here on every `admit` throws `reason` and changes nothing: the runtime is being handed to
	 * another writer, so the delivery stays with its sender and is delivered there instead.
	 */
	close(reason: string): void {
		this.closedReason ??= reason;
	}

	/** Undoes `close` when the hand-over it was closed for did not happen. */
	reopen(): void {
		this.closedReason = undefined;
	}

	gate(): SessionAdmissionGate {
		const editor = this.editorSource?.() ?? { revision: 0 };
		const base = { editor_revision: editor.revision, turn_epoch: this.turnEpochValue };
		if (this.inputHolds.size > 0) return { can_admit: false, hold_reason: "draft", ...base };
		return editor.hold_reason === undefined
			? { can_admit: true, ...base }
			: { can_admit: false, hold_reason: editor.hold_reason, ...base };
	}

	admit(input: AdmitExternalMessageInput): ExternalAdmissionResult {
		if (this.closedReason !== undefined) throw new Error(this.closedReason);
		const turn_epoch = this.turnEpochValue;
		const id = input.delivery_id;
		if (this.pending.has(id) || this.emitted.has(id) || this.failed.has(id)) {
			return { kind: "already_admitted", turn_epoch };
		}
		if (!this.gate().can_admit) return { kind: "held_draft", turn_epoch };
		if (input.expected_turn_id !== undefined && input.expected_turn_id !== turn_epoch) {
			return { kind: "turn_conflict", turn_epoch };
		}
		const message = deliveryMessage(input);
		if (!this.isBusy()) {
			this.pending.set(id, "start");
			// A start that settles without writing the entry left it queued for later (the runtime's
			// admission-retention path): from then on it is held like any queued delivery.
			void this.port.start(message).finally(() => {
				if (this.pending.get(id) === "start") this.pending.set(id, "followUp");
			});
			return { kind: "started", turn_epoch };
		}
		if (input.deliverAs === "steer") {
			if (input.expected_turn_id === undefined) return { kind: "turn_conflict", turn_epoch };
			this.pending.set(id, "steer");
			this.port.enqueue(message, "steer");
			return { kind: "steered", turn_epoch };
		}
		this.pending.set(id, "followUp");
		this.port.enqueue(message, "followUp");
		return { kind: "queued", turn_epoch };
	}

	list(): AdmittedDeliveries {
		const deliveries = { pending: [...this.pending.keys()], emitted: [...this.emitted] };
		if (this.failed.size === 0) return deliveries;
		const failed = [...this.failed].map(([delivery_id, error]) => ({ delivery_id, error }));
		return { ...deliveries, failed };
	}

	/** A message's transcript entry was written: the file takes writes; a delivery's own entry makes it emitted. */
	observePersisted(message: AgentMessage): void {
		this.fileTakesWrites = true;
		const id = deliveryIdOf(message);
		if (id === undefined || this.emitted.has(id)) return;
		this.pending.delete(id);
		this.emitted.add(id);
		for (const listener of this.emittedListeners) listener(id);
	}

	/**
	 * The session file refused a delivery's entry: the delivery is settled as failed with `error` and is
	 * no longer held, so its start stops counting as busy and later deliveries start. It stays with its sender.
	 */
	observeRefused(message: AgentMessage, error: string): void {
		this.fileTakesWrites = false;
		const id = deliveryIdOf(message);
		if (id === undefined || this.emitted.has(id)) return;
		this.pending.delete(id);
		this.failed.set(id, error);
	}

	/**
	 * A run settled: its refused messages leave the model context at the next run's start, so the failed
	 * deliveries may be admitted again - unless the file's last write was refused too.
	 */
	observeRunSettled(): void {
		if (this.fileTakesWrites) this.failed.clear();
	}

	/** The runtime's queues were cleared: queued deliveries are no longer held. */
	dropQueued(): void {
		for (const [id, lane] of this.pending) {
			if (lane !== "start") this.pending.delete(id);
		}
	}

	private endHold(state: InputHoldState): void {
		if (!this.inputHolds.delete(state)) return;
		if (this.inputHolds.size === 0) for (const listener of this.settledListeners) listener();
	}

	private isBusy(): boolean {
		if (this.port.isBusy()) return true;
		for (const lane of this.pending.values()) if (lane === "start") return true;
		return false;
	}
}

interface InputHoldState {
	readonly command: boolean;
}

export interface InputHold {
	/** The runtime took the input: it started a turn, was queued, or was handled. */
	accepted(): void;
	/** The submission ended without being accepted (it threw, was cancelled, or never submitted). */
	end(): void;
}

function deliveryMessage(input: AdmitExternalMessageInput): SessionControlDeliveryMessage {
	return {
		role: "custom",
		customType: SESSION_CONTROL_DELIVERY_TYPE,
		content: input.text,
		display: true,
		details: {
			delivery_id: input.delivery_id,
			source: "session_control",
			deliverAs: input.deliverAs,
			...(input.sender === undefined ? {} : { sender: input.sender }),
			...(input.display_text === undefined ? {} : { display_text: input.display_text }),
		},
		timestamp: Date.now(),
	};
}

export function deliveryIdOf(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || message.customType !== SESSION_CONTROL_DELIVERY_TYPE) return undefined;
	return isSessionControlDeliveryDetails(message.details) ? message.details.delivery_id : undefined;
}
