import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";
import type { CallFold } from "./compact-call-fold.ts";
import { CALL_RECORDS } from "./compact-call-model.ts";
import type { CompactColdOutcome } from "./compact-cold-operations.ts";
import { COMPONENT_RECORDS } from "./compact-current-components.ts";
import { type CanonicalUnit, laneTransition } from "./compact-lane-transitions.ts";
import { assertProtocolDepth, protocolClone, protocolDepthLimitOf } from "./compact-protocol-depth.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { CompactSessionState, type CompactSessionStateOptions } from "./compact-session-state.ts";
import type { CompactSettledMessages } from "./compact-settled-messages.ts";
import type { FrozenCompactState } from "./compact-state-view.ts";
import { compactColdFlow } from "./compact-transcript-flows.ts";
import type { CompactPersistence, CompactTransition } from "./compact-transition.ts";

/**
 * The lane's compact current state for one epoch (S03b-3): folded inside the lane's own acceptance step at the
 * lane's sequence, accepting only that epoch's registry nonce (RULING-39). A rejected fold makes it unavailable for the
 * rest of the epoch (legacy delivery is unaffected), so a cut never holds a partial or silently stale state.
 */
export class CompactLaneCurrent {
	private state: CompactSessionState | undefined;
	private cleanup: Promise<void> = Promise.resolve();
	private coldChain: Promise<void> = Promise.resolve();
	private readonly owners = new WeakMap<FrozenCompactState, CompactSessionState>();
	private refused = 0;

	/**
	 * Records refused at the protocol depth limit over this lane's lifetime, one per session event, whether or not the
	 * epoch's compact state is still live: a real loss ends the state, never the count. The legacy path (`admits`) and
	 * the canonical path (`fail`) follow this one rule (RULING-59 C).
	 */
	get refusedRecords(): number {
		return this.refused;
	}

	/** Open broadcast questions now; undefined once this epoch's compact state is unavailable. */
	get openBroadcastDialogs(): number | undefined {
		return this.state?.openBroadcastDialogs;
	}

	bootstrap(options: CompactSessionStateOptions & { readonly epoch: string }): void {
		this.retire();
		this.state = new CompactSessionState(options);
	}

	/**
	 * The one protocol depth check of a legacy record a compact fold would clone or serialize (the call and component
	 * folds, the settled terminal of a `message_end`), run before any of them (RULING-59 C). A refused record is counted
	 * and reported here, once, under the `refusedRecords` rule (live or retired state alike); a cycle ends the current
	 * state. Either way the record must change no compact component.
	 */
	admits(record: object, type: string): boolean {
		if (type !== "message_end" && !CALL_RECORDS.has(type) && !COMPONENT_RECORDS.has(type)) return true;
		try {
			assertProtocolDepth(record);
			return true;
		} catch (cause) {
			const limit = protocolDepthLimitOf(cause);
			if (limit === undefined) this.fail(cause);
			else this.refuse(limit);
			return false;
		}
	}

	fold(unit: CanonicalUnit, sequence: number, turnId: string | null = null): void {
		this.apply(() => laneTransition(unit), sequence, turnId);
	}

	/** A host-origin lifecycle, run-state or dialog record, taken at the same JSON boundary as canonical records. */
	foldComponent(record: object, sequence: number): void {
		this.apply(() => ({ type: "component", record: protocolClone(record) }), sequence);
	}

	/** An execution, hook or boundary record for the calls component (S06); undefined once the state is unavailable. */
	foldCall(record: object, sequence: number, turnId: string | null): CallFold | undefined {
		if (!this.state) return undefined;
		try {
			return this.state.acceptCall(protocolClone(record), sequence, turnId);
		} catch (cause) {
			this.fail(cause);
			return undefined;
		}
	}

	/**
	 * The cold work of one accepted transcript transition: an owned append makes its message appended, and the flow a
	 * real producer committed (edit, context-edit removal, compaction, branch) maps through this epoch's settled joins.
	 */
	transcript(transition: TranscriptTransition, settled: CompactSettledMessages, epoch: string): void {
		if (transition.kind === "append" && transition.owningMessageId && transition.recoveryEpoch === epoch)
			this.status(transition.owningMessageId, "appended");
		const flow = transition.kind === "append" || transition.kind === "leaf" ? transition.flow : undefined;
		if (flow)
			this.cold(async (state) => {
				const cold = await compactColdFlow(flow, (entryIds) => settled.messagesOf(entryIds));
				return cold && state.applyColdFlow(cold);
			});
	}

	/** Persistence from the transcript join: a message this state never held, or one still live, keeps its status. */
	status(messageId: string, persistence: CompactPersistence): void {
		this.cold((state) => state.applyCold({ type: "message_status", messageId, persistence }));
	}

	/**
	 * Cold work ordered after acceptance (RULING-33 cond. 2): steps run one at a time in acceptance order, each against
	 * the epoch it was accepted in; an outcome the store failed to write stops that epoch's compact state.
	 */
	cold(step: (state: CompactSessionState) => Promise<CompactColdOutcome | readonly CompactColdOutcome[] | undefined>) {
		const state = this.state;
		if (!state) return;
		this.coldChain = this.coldChain.then(async () => {
			try {
				const failed = [(await step(state)) ?? []].flat().find((outcome) => outcome.kind === "failed");
				if (failed && this.state === state) this.fail(failed.cause);
			} catch (cause) {
				if (this.state === state) this.fail(cause);
			}
		});
	}

	/** Never throws: building the transition from a worker frame's record is part of the fold that may fail. */
	private apply(build: () => CompactTransition | undefined, sequence: number, turnId: string | null = null): void {
		if (!this.state) return;
		try {
			const transition = build();
			if (transition) this.state.accept(transition, sequence, turnId);
		} catch (cause) {
			this.fail(cause);
		}
	}

	freeze(): FrozenCompactState | undefined {
		const state = this.state;
		if (!state) return undefined;
		try {
			const cut = state.freeze();
			this.owners.set(cut, state);
			return cut;
		} catch (cause) {
			this.fail(cause);
			return undefined;
		}
	}

	release(cut: FrozenCompactState | undefined): void {
		if (cut) this.owners.get(cut)?.release(cut);
	}

	read(cut: FrozenCompactState | undefined) {
		return this.owned(cut, (owner, held) => owner.read(held));
	}

	readComponents(cut: FrozenCompactState | undefined) {
		return this.owned(cut, (owner, held) => owner.readComponents(held));
	}

	readActive(cut: FrozenCompactState | undefined) {
		return this.owned(cut, (owner, held) => owner.readActive(held));
	}

	readCalls(cut: FrozenCompactState | undefined) {
		return this.owned(cut, (owner, held) => owner.readCalls(held));
	}

	private owned<T>(
		cut: FrozenCompactState | undefined,
		read: (owner: CompactSessionState, cut: FrozenCompactState) => Promise<T>,
	): Promise<T> {
		const owner = cut && this.owners.get(cut);
		if (!cut) return Promise.reject(new CompactReadError("unavailable"));
		if (!owner) return Promise.reject(new CompactReadError("ownership"));
		return read(owner, cut);
	}

	retire(): void {
		const state = this.state;
		this.state = undefined;
		if (state) this.cleanup = Promise.all([this.cleanup, state.retire()]).then(() => {});
	}

	idle(): Promise<void> {
		return Promise.all([this.cleanup, this.coldChain, this.state?.idle()]).then(() => {});
	}

	/**
	 * The epoch's compact component stops here: a fold failed, or a canonical record never reached this lane. A record
	 * refused at the protocol depth limit is the exception (RULING-59 C): it was refused before anything was cloned or
	 * folded, so it is counted and reported, also once the state is already gone, and a live state stays available.
	 */
	fail(cause: unknown): void {
		const limit = protocolDepthLimitOf(cause);
		if (limit !== undefined) return this.refuse(limit);
		if (!this.state) return;
		const reason = cause instanceof Error && "reason" in cause ? String(cause.reason) : String(cause);
		process.stderr.write(`senpi rpc acceptance: compact current state unavailable: ${reason}\n`);
		this.retire();
	}

	private refuse(limit: number): void {
		this.refused += 1;
		process.stderr.write(`senpi rpc acceptance: compact record refused: unsupported_value (depth above ${limit})\n`);
	}
}
