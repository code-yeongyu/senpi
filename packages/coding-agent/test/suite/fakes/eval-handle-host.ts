import {
	type AgentToolResult,
	type CancelReceipt,
	EvalHandleError,
	type EvalHandleHost,
	type HandleCallContext,
	type HandleError,
	type HandleKind,
	type HandleOutcome,
	type HandlePhase,
	type HandleRef,
	type HandleSnapshot,
	type HandleWatch,
	type OutputRequest,
	type OutputSnapshot,
} from "../../../src/index.ts";
import {
	type FakeEpochState,
	type FakeHostCall,
	type FakeWork,
	fakeHandleId,
	newEpoch,
	outcomeOf,
} from "./eval-handle-host-state.ts";
import { FakeWatchQueue } from "./eval-handle-host-watch.ts";

export type { FakeHostCall } from "./eval-handle-host-state.ts";

export interface FakeEvalHandleHostOptions {
	readonly ownerSessionId: string;
	/** Runs inside `watch()` after the subscription exists and before `initial` is taken. */
	readonly watchSetupHook?: () => Promise<void> | void;
}

/**
 * TEST-ONLY `EvalHandleHost`. It owns scripted task-shaped work (agents, workpools) and enforces the
 * guarantees the capability types cannot express: `initial` and the subscription are atomic, revisions
 * strictly increase per ref, every operation is fenced by owner, id and run epoch (stale ->
 * `eval_handle_stale`, foreign -> `eval_handle_forbidden`), `send`/`cancel` touch only the exact epoch,
 * `cancel` and `close` are idempotent, and `output` returns one epoch's transcript only. It also answers
 * as the host `task` tool so a cell's `agent(..., {handle: true})` spawns its children here.
 */
export class FakeEvalHandleHost implements EvalHandleHost {
	readonly version = 1 as const;
	readonly calls: FakeHostCall[] = [];
	readonly toolCalls: Array<{ readonly name: string; readonly args: unknown }> = [];
	/** Owner of newly spawned work; a task owner binds it to the live session at `session_start`. */
	ownerSessionId: string;
	watchSetupHook: (() => Promise<void> | void) | undefined;
	readonly #work = new Map<string, FakeWork>();
	readonly #watches = new Set<FakeWatchQueue>();
	#nextId = 1;

	constructor(options: FakeEvalHandleHostOptions) {
		this.ownerSessionId = options.ownerSessionId;
		this.watchSetupHook = options.watchSetupHook;
	}

	// ---- scripting surface -------------------------------------------------------------------------

	spawn(kind: HandleKind, options: { ownerSessionId?: string; hostStatus?: string } = {}): HandleRef {
		const id = fakeHandleId(kind, this.#nextId++);
		const work: FakeWork = {
			kind,
			id,
			ownerSessionId: options.ownerSessionId ?? this.ownerSessionId,
			liveEpoch: 0,
			epochs: new Map([[0, newEpoch(options.hostStatus ?? (kind === "workpool" ? "open" : "running"))]]),
		};
		this.#work.set(id, work);
		return { kind, id, run_epoch: 0 };
	}

	settle(id: string, value: unknown): void {
		this.#transition(id, { phase: "succeeded", hostStatus: "completed", value });
	}

	fail(id: string, error: HandleError): void {
		this.#transition(id, { phase: "failed", hostStatus: "failed", error });
	}

	lose(id: string): void {
		const error = { code: "eval_handle_lost", message: `${id} was lost` };
		this.#transition(id, { phase: "lost", hostStatus: "lost", error });
	}

	closePool(id: string): void {
		const epoch = this.#liveEpoch(id);
		if (epoch.phase !== "pending") throw new Error(`fake host: ${id} already settled`);
		epoch.hostStatus = "closed";
		epoch.revision += 1;
		this.#notify(id);
	}

	settlePool(id: string, keys: Readonly<Record<string, HandleOutcome>>): void {
		const failed = Object.values(keys).filter((outcome) => outcome.status === "rejected").length;
		if (failed === 0) this.settle(id, { keys });
		else {
			const message = `${failed} of ${Object.keys(keys).length} keys failed`;
			this.fail(id, { code: "eval_workpool_failed", message, details: { keys } });
		}
	}

	/** Starts a successor run; the previous epoch must already be terminal and stays exactly as it was. */
	resume(id: string): HandleRef {
		const work = this.#require(id);
		if (this.#liveEpoch(id).phase === "pending") throw new Error(`fake host: settle ${id} before resuming it`);
		work.liveEpoch += 1;
		work.epochs.set(work.liveEpoch, newEpoch("running"));
		return { kind: work.kind, id, run_epoch: work.liveEpoch };
	}

	appendTranscript(id: string, line: string): void {
		this.#liveEpoch(id).transcript.push(line);
	}

	epochState(id: string, runEpoch: number): Readonly<FakeEpochState> {
		const state = this.#require(id).epochs.get(runEpoch);
		if (!state) throw new Error(`fake host: ${id} has no epoch ${runEpoch}`);
		return state;
	}

	get openWatches(): number {
		return [...this.#watches].filter((watch) => !watch.closed).length;
	}

	toolCallCount(name: string): number {
		return this.toolCalls.filter((call) => call.name === name).length;
	}

	/** The host `task` / `task_output` tools, so a cell's `agent(..., {handle: true})` spawns work here. */
	readonly executeTool = async (toolName: string, args: unknown): Promise<AgentToolResult<unknown>> => {
		this.toolCalls.push({ name: toolName, args });
		if (toolName === "task") {
			const ref = this.spawn("agent");
			return {
				content: [{ type: "text", text: `spawned ${ref.id}` }],
				details: { task_id: ref.id, run_epoch: ref.run_epoch, status: "running" },
			};
		}
		if (toolName === "task_output") return { content: [{ type: "text", text: "transcript" }], details: {} };
		throw Object.assign(new Error(`unknown tool ${toolName}`), { code: "unknown_tool" });
	};

	// ---- EvalHandleHost ----------------------------------------------------------------------------

	async watch(refs: readonly HandleRef[], ctx: HandleCallContext): Promise<HandleWatch> {
		this.#record("watch", refs, ctx);
		for (const ref of refs) this.#fence(ref, ctx);
		const queue = new FakeWatchQueue(refs);
		// Subscribe BEFORE the initial snapshot so nothing between the two can be missed.
		this.#watches.add(queue);
		await this.watchSetupHook?.();
		const initial = refs.map((ref) => this.#snapshot(ref));
		if (ctx.signal) ctx.signal.addEventListener("abort", () => queue.close(), { once: true });
		return queue.toWatch(initial);
	}

	async result(ref: HandleRef, ctx: HandleCallContext): Promise<HandleOutcome> {
		this.#record("result", [ref], ctx);
		const epoch = this.#fence(ref, ctx);
		if (epoch.phase === "pending") throw new EvalHandleError("eval_handle_pending", `${ref.id} is still running`);
		return outcomeOf(ref, epoch);
	}

	async send(ref: HandleRef, message: string, ctx: HandleCallContext): Promise<HandleSnapshot> {
		this.#record("send", [ref], ctx);
		const epoch = this.#fence(ref, ctx);
		if (ref.kind !== "agent") {
			throw new EvalHandleError("eval_handle_operation_unsupported", `send() is for agent handles, not ${ref.kind}`);
		}
		epoch.transcript.push(`[user] ${message}`);
		epoch.revision += 1;
		this.#notify(ref.id);
		return this.#snapshot(ref);
	}

	async cancel(ref: HandleRef, ctx: HandleCallContext): Promise<CancelReceipt> {
		this.#record("cancel", [ref], ctx);
		const epoch = this.#fence(ref, ctx);
		epoch.cancelCalls.push(Date.now());
		if (epoch.phase !== "pending") return { ref, cancelled: false, phase: epoch.phase };
		const error = { code: "eval_handle_cancelled", message: `${ref.id} was cancelled` };
		this.#transition(ref.id, { phase: "cancelled", hostStatus: "cancelled", error });
		return { ref, cancelled: true, phase: "cancelled" };
	}

	async output(ref: HandleRef, request: OutputRequest, ctx: HandleCallContext): Promise<OutputSnapshot> {
		this.#record("output", [ref], ctx);
		const epoch = this.#fence(ref, ctx);
		const total = epoch.transcript.length;
		const window =
			request.format === "tail"
				? epoch.transcript.slice(-(request.limit ?? 20))
				: epoch.transcript.slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? total));
		const offset = request.format === "tail" ? total - window.length : (request.offset ?? 0);
		return { ref, text: window.join("\n"), offset, total, truncated: window.length < total };
	}

	// ---- internals ---------------------------------------------------------------------------------

	#record(op: FakeHostCall["op"], refs: readonly HandleRef[], ctx: HandleCallContext): void {
		this.calls.push({ op, refs: refs.map((ref) => ({ ...ref })), ownerSessionId: ctx.ownerSessionId });
	}

	#require(id: string): FakeWork {
		const work = this.#work.get(id);
		if (!work) throw new EvalHandleError("eval_handle_not_found", `no handle ${id}`);
		return work;
	}

	#liveEpoch(id: string): FakeEpochState {
		const work = this.#require(id);
		const epoch = work.epochs.get(work.liveEpoch);
		if (!epoch) throw new Error(`fake host: ${id} lost its live epoch`);
		return epoch;
	}

	/** Owner, id and epoch are checked together before any read or mutation of the epoch state. */
	#fence(ref: HandleRef, ctx: HandleCallContext): FakeEpochState {
		const work = this.#require(ref.id);
		if (work.ownerSessionId !== ctx.ownerSessionId) {
			throw new EvalHandleError("eval_handle_forbidden", `${ref.id} belongs to another session`);
		}
		if (work.kind !== ref.kind) {
			throw new EvalHandleError("eval_handle_not_found", `${ref.id} is a ${work.kind}, not a ${ref.kind}`);
		}
		const epoch = work.epochs.get(ref.run_epoch);
		if (ref.run_epoch !== work.liveEpoch || !epoch) {
			const detail = `run epoch ${ref.run_epoch} is no longer live (live epoch ${work.liveEpoch})`;
			throw new EvalHandleError("eval_handle_stale", `${ref.id} ${detail}`);
		}
		return epoch;
	}

	#snapshot(ref: HandleRef): HandleSnapshot {
		const work = this.#require(ref.id);
		const epoch = work.epochs.get(ref.run_epoch);
		if (!epoch) throw new EvalHandleError("eval_handle_stale", `${ref.id} has no epoch ${ref.run_epoch}`);
		return {
			ref: { kind: work.kind, id: work.id, run_epoch: ref.run_epoch },
			phase: epoch.phase,
			host_status: epoch.hostStatus,
			revision: epoch.revision,
		};
	}

	#transition(
		id: string,
		next: { phase: HandlePhase; hostStatus: string; value?: unknown; error?: HandleError },
	): void {
		const epoch = this.#liveEpoch(id);
		if (epoch.phase !== "pending") throw new Error(`fake host: ${id} already settled as ${epoch.phase}`);
		epoch.phase = next.phase;
		epoch.hostStatus = next.hostStatus;
		if ("value" in next) epoch.value = next.value;
		if (next.error) epoch.error = next.error;
		epoch.revision += 1;
		this.#notify(id);
	}

	#notify(id: string): void {
		const work = this.#require(id);
		const snapshot = this.#snapshot({ kind: work.kind, id, run_epoch: work.liveEpoch });
		for (const watch of this.#watches) watch.push(snapshot);
	}
}
