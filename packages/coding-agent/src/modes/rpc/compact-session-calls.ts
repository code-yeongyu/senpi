import {
	type CallCorrelation,
	type CallProjection,
	type CallRaw,
	type CallScope,
	type FrozenCalls,
	type OutstandingCall,
	runtimeItemKey,
	TERMINAL_PHASE,
	terminal,
} from "./compact-call-model.ts";
import { NOT_EXECUTED, orphaned, settleCall, settledPatch } from "./compact-call-retirement.ts";
import { CompactCallTable, creationOf } from "./compact-call-table.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { ValueRef } from "./compact-values.ts";

export interface CallStep {
	readonly sequence: number;
	readonly scope: CallScope;
}
export interface AnnouncedBlock {
	readonly messageId: string;
	readonly contentIndex: number;
	readonly id: string;
	readonly name: string;
	readonly arguments: unknown;
	readonly resolvedName?: string;
	readonly correlation?: CallCorrelation;
}
export interface ExecutionStart {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
	readonly parentToolCallId?: string;
}

/** The four "can still take this record" states, one per record kind; every per-id record picks the oldest such call. */
const awaitingStart = (call: OutstandingCall) => call.startSequence === null && !terminal(call);
const executing = (call: OutstandingCall) => call.phase === "executing";
const stillOpen = (call: OutstandingCall) => !terminal(call);
const awaitingCarrier = (call: OutstandingCall) => call.join === "pending";

const FRESH = {
	owningMessageId: null,
	contentIndex: null,
	parentKey: null,
	join: "pending",
	startSequence: null,
	startedAtMs: null,
	requestedName: null,
	resolvedName: null,
	seed: null,
	raw: null,
	input: { announced: null, started: null, prepared: null },
	correlation: null,
	hook: null,
	progress: null,
	result: null,
	outcome: null,
} as const;

/**
 * The outstanding-call phase machine (R3.C3.1-C3.3, RULING-13): one reducer, phases only forward, records in any
 * order, a host-minted key fixed at creation. Every change republishes the calls root at the lane sequence given.
 */
export class CompactSessionCalls {
	readonly table: CompactCallTable;
	sequence = 0;
	private mintedAt = -1;
	private mintedK = 0;

	constructor(store: CompactContentStore) {
		this.table = new CompactCallTable(store);
	}

	get(key: string): OutstandingCall | undefined {
		return this.table.get(key);
	}

	/**
	 * `toolcall_start`: a bridge-started call joins by id and, like a fresh one, reads its raw prefix through the active
	 * block until its end (C3 cond. 3); an owned slot with the same id is a collision.
	 */
	toolStart(step: CallStep, block: AnnouncedBlock): void {
		const turnId = step.scope.turnId;
		if (turnId === null) return;
		const id = block.id || null;
		const existing = this.table.byTurnId(turnId, id);
		const raw: CallRaw = { kind: "active", messageId: block.messageId, contentIndex: block.contentIndex };
		const fields = {
			owningMessageId: block.messageId,
			contentIndex: block.contentIndex,
			seed: block.arguments,
			raw,
			...(block.correlation ? { correlation: block.correlation } : {}),
		};
		if (existing && existing.owningMessageId === null && existing.parentKey === null) {
			this.update(step, existing, { ...fields, requestedName: existing.requestedName ?? block.name });
			return;
		}
		if (existing) this.table.counters.collisions++;
		this.create(step, {
			turnId,
			toolCallId: id,
			phase: "streaming",
			requestedName: block.name || null,
			resolvedName: block.resolvedName ?? null,
			...fields,
		});
	}

	requestedName(step: CallStep, messageId: string, contentIndex: number, name: string): void {
		const call = this.table.byOwner(messageId, contentIndex);
		if (call) this.update(step, call, { requestedName: name });
	}

	/** `toolcall_end` and each terminal block: the announcement's final id, name and input; the call owns the raw. */
	announce(step: CallStep, block: AnnouncedBlock, raw: CallRaw | null): void {
		const call = this.table.byOwner(block.messageId, block.contentIndex);
		const turnId = step.scope.turnId;
		if (!call) {
			if (turnId === null) return;
			this.create(step, {
				turnId,
				toolCallId: block.id || null,
				owningMessageId: block.messageId,
				contentIndex: block.contentIndex,
				phase: "awaiting-execution",
				requestedName: block.name || null,
				resolvedName: block.resolvedName ?? null,
				raw,
				input: { announced: block.arguments, started: null, prepared: null },
				...(block.correlation ? { correlation: block.correlation } : {}),
			});
			return;
		}
		const id = block.id || null;
		const taken = id && id !== call.toolCallId ? this.table.indexedTo(call.turnId, id) : undefined;
		if (taken !== undefined) this.table.counters.collisions++;
		this.update(step, call, {
			...(taken === undefined && id ? { toolCallId: id } : {}),
			phase: call.phase === "streaming" ? "awaiting-execution" : call.phase,
			requestedName: block.name || call.requestedName,
			resolvedName: block.resolvedName ?? call.resolvedName,
			input: { ...call.input, announced: block.arguments },
			raw: call.raw?.kind === "owned" ? call.raw : raw,
		});
	}

	executionStart(step: CallStep, start: ExecutionStart): void {
		const turnId = step.scope.turnId;
		if (turnId === null) return;
		const started = {
			startSequence: step.sequence,
			startedAtMs: Date.now(),
			resolvedName: start.toolName,
		};
		const announced = this.table.oldestById(start.toolCallId, turnId, awaitingStart);
		if (announced) {
			this.update(step, announced, {
				...started,
				phase: "executing",
				input: { ...announced.input, started: start.args },
			});
			return;
		}
		const existing = this.table.byTurnId(turnId, start.toolCallId);
		if (existing) this.table.counters.reused++;
		const parent = start.parentToolCallId ? this.lookup(turnId, start.parentToolCallId) : undefined;
		const created = this.create(step, {
			turnId,
			toolCallId: start.toolCallId,
			parentKey: parent?.runtimeItemKey ?? null,
			phase: "executing",
			input: { announced: null, started: start.args, prepared: null },
			...started,
		});
		if (existing) this.table.repoint(turnId, start.toolCallId, created.runtimeItemKey);
	}

	executionUpdate(step: CallStep, toolCallId: string, args: unknown, partialResult: unknown): void {
		const call = this.resolve(step, toolCallId, executing);
		if (!call) return this.ignore("unknown");
		if (call.phase !== "executing") return this.ignore("late");
		const progressed = this.table.replaceSlot(call, "progress", partialResult);
		this.table.counters.progressReplacements++;
		if (call.input.prepared === null) this.update(step, progressed, { input: { ...call.input, prepared: args } });
		this.sequence = step.sequence;
	}

	hook(step: CallStep, toolCallId: string, record: unknown): void {
		const call = this.resolve(step, toolCallId, stillOpen);
		if (!call) return this.ignore("unknown");
		if (terminal(call)) return this.ignore("late");
		this.table.replaceSlot(call, "hook", record);
		this.sequence = step.sequence;
	}

	/** An end closes the oldest call still open under its id (senpi#4278); with none open it may replace an abandoned one. */
	executionEnd(step: CallStep, toolCallId: string, result: unknown, isError: boolean): void {
		const call = this.resolve(step, toolCallId, stillOpen);
		if (!call) return this.ignore("unknown");
		if (terminal(call) && call.outcome?.kind !== "abandoned") return this.ignore("late");
		const ended = this.table.replaceSlot(call, "result", result);
		this.update(step, ended, {
			phase: TERMINAL_PHASE,
			outcome: { kind: "result", isError, source: "execution_end" },
			join: orphaned(this.table, call) || call.join === "carrierless" ? "carrierless" : "pending",
		});
	}

	/**
	 * The carrier settled (RULING-13 Q2): the oldest call under its id still awaiting a carrier, own turn first (the
	 * same order the ends closed them in, senpi#4278), leaves with its completed descendants as one projection.
	 */
	settle(step: CallStep, toolCallId: string, isError: boolean): CallProjection | undefined {
		const call = this.resolve(step, toolCallId, awaitingCarrier);
		if (!call) return undefined;
		const projection = settleCall(this.table, call, isError);
		this.sequence = step.sequence;
		return projection;
	}

	/** RULING-13 Q3: a never-started call ends as an explicit `not-executed` terminal, never a silent removal. */
	turnEnd(step: CallStep): void {
		const turnId = step.scope.turnId;
		if (turnId === null) return;
		for (const call of [...this.table.ofTurn(turnId)])
			if (call.startSequence === null && !terminal(call)) this.update(step, call, NOT_EXECUTED);
	}

	/** RULING-13 Q4: after the run settled no carrier can arrive; started calls stay carrierless until retirement. */
	agentSettled(step: CallStep): void {
		for (const call of [...this.table.all()]) {
			const patch = settledPatch(call);
			if (patch) this.update(step, call, patch);
		}
	}

	freeze(): FrozenCalls {
		return { sequence: this.sequence, ref: this.table.freeze(), counters: this.table.snapshot() };
	}

	release(frozen: FrozenCalls): void {
		this.table.release(frozen.ref);
	}

	entries(ref: ValueRef | undefined, valid: () => void) {
		return this.table.entriesOf(ref, valid);
	}

	/** FIFO (senpi#4278): the oldest call under the id that can take the record, own turn first; none open, the newest. */
	private resolve(step: CallStep, toolCallId: string, open: (call: OutstandingCall) => boolean) {
		const turnId = step.scope.turnId;
		return this.table.oldestById(toolCallId, turnId, open) ?? this.lookup(turnId, toolCallId);
	}

	private lookup(turnId: string | null, toolCallId: string): OutstandingCall | undefined {
		return this.table.byTurnId(turnId, toolCallId) ?? this.table.newestById(toolCallId);
	}

	private ignore(kind: "unknown" | "late"): void {
		this.table.counters[kind]++;
	}

	private create(step: CallStep, fields: Partial<OutstandingCall> & Pick<OutstandingCall, "turnId" | "phase">) {
		if (this.mintedAt !== step.sequence) {
			this.mintedAt = step.sequence;
			this.mintedK = 0;
		} else this.mintedK++;
		const call: OutstandingCall = {
			...FRESH,
			toolCallId: null,
			...fields,
			runtimeItemKey: runtimeItemKey(step.scope, step.sequence, this.mintedK),
		};
		this.table.put(call, { sequence: step.sequence, k: this.mintedK });
		this.sequence = step.sequence;
		return call;
	}

	private update(step: CallStep, call: OutstandingCall, patch: Partial<OutstandingCall>): void {
		this.table.put({ ...call, ...patch }, creationOf(call));
		this.sequence = step.sequence;
	}
}
