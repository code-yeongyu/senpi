import { randomBytes } from "node:crypto";
import {
	type CancelReceipt,
	EvalHandleError,
	type HandleError,
	type HandleOutcome,
	type HandlePhase,
	type HandleRef,
	type HandleSnapshot,
	type HandleWatch,
	type OutputRequest,
	type OutputSnapshot,
} from "@code-yeongyu/senpi";
import { refKey } from "./handle-args.ts";
import { WatchQueue } from "./watch-queue.ts";

export interface CompletionStart {
	/** Runs the host completion; the signal aborts on cancel, on the deadline, and when the session generation drops. */
	readonly run: (signal: AbortSignal) => Promise<unknown>;
	/** Absolute wall-clock deadline (ms), derived from the creating cell's hard deadline. */
	readonly deadlineMs: number;
}

interface CompletionEntry {
	readonly ref: HandleRef;
	phase: HandlePhase;
	hostStatus: string;
	revision: number;
	value?: unknown;
	error?: HandleError;
	readonly controller: AbortController;
	timer: ReturnType<typeof setTimeout> | undefined;
	deadlineHit: boolean;
}

const TERMINAL: ReadonlySet<HandlePhase> = new Set(["succeeded", "failed", "cancelled", "lost"]);
const DEADLINE_MESSAGE = "completion handle exceeded its cell's hard deadline";
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * codemode-owned completion handles (`completion(prompt, {handle: true})`). They live in the session's
 * registry, so they survive a kernel restart and need no host capability; once the session generation
 * is dropped every ref fails closed with `eval_handle_stale`.
 */
export class CompletionHandles {
	readonly #entries = new Map<string, CompletionEntry>();
	readonly #watches = new Set<WatchQueue>();
	readonly #now: () => number;
	#disposed = false;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	start(input: CompletionStart): HandleRef {
		this.#assertLive();
		const ref: HandleRef = { kind: "completion", id: `cp_${randomBytes(16).toString("hex")}`, run_epoch: 0 };
		const controller = new AbortController();
		const entry: CompletionEntry = {
			ref,
			phase: "pending",
			hostStatus: "running",
			revision: 1,
			controller,
			timer: undefined,
			deadlineHit: false,
		};
		this.#entries.set(ref.id, entry);
		const remainingMs = Math.min(MAX_TIMER_MS, Math.max(0, input.deadlineMs - this.#now()));
		if (Number.isFinite(remainingMs)) {
			entry.timer = setTimeout(() => {
				entry.deadlineHit = true;
				controller.abort(new Error(DEADLINE_MESSAGE));
			}, remainingMs);
			entry.timer.unref?.();
		}
		input.run(controller.signal).then(
			(value) => this.#settle(entry, { phase: "succeeded", hostStatus: "completed", value }),
			(error: unknown) => {
				// cancel() and dispose() settle the entry before aborting; their rejection is not an outcome.
				if (TERMINAL.has(entry.phase)) return;
				const hostStatus = entry.deadlineHit ? "deadline" : "failed";
				this.#settle(entry, { phase: "failed", hostStatus, error: toHandleError(error, entry.deadlineHit) });
			},
		);
		return ref;
	}

	get openWatches(): number {
		return this.#watches.size;
	}

	owns(ref: HandleRef): boolean {
		return ref.kind === "completion";
	}

	watch(refs: readonly HandleRef[]): HandleWatch {
		const entries = refs.map((ref) => this.#fence(ref));
		const queue = new WatchQueue(refs.map(refKey));
		// Subscribe first, then snapshot: a settle between the two is queued and arrives in updates once.
		this.#watches.add(queue);
		const initial = entries.map((entry) => snapshotOf(entry));
		return queue.toWatch(initial, () => this.#watches.delete(queue));
	}

	result(ref: HandleRef): HandleOutcome {
		const entry = this.#fence(ref);
		if (!TERMINAL.has(entry.phase)) throw new EvalHandleError("eval_handle_pending", `${ref.id} is still running`);
		if (entry.phase === "succeeded") return { status: "fulfilled", ref: entry.ref, value: entry.value };
		return {
			status: "rejected",
			ref: entry.ref,
			error: entry.error ?? { code: "eval_handle_lost", message: `${ref.id} ended without an outcome` },
		};
	}

	cancel(ref: HandleRef): CancelReceipt {
		const entry = this.#fence(ref);
		if (TERMINAL.has(entry.phase)) return { ref: entry.ref, cancelled: false, phase: entry.phase };
		const error = { code: "eval_handle_cancelled", message: `${ref.id} was cancelled` };
		this.#settle(entry, { phase: "cancelled", hostStatus: "cancelled", error });
		entry.controller.abort(new Error(error.message));
		return { ref: entry.ref, cancelled: true, phase: "cancelled" };
	}

	output(ref: HandleRef, request: OutputRequest): OutputSnapshot {
		const entry = this.#fence(ref);
		const text =
			entry.phase === "succeeded"
				? typeof entry.value === "string"
					? entry.value
					: JSON.stringify(entry.value)
				: (entry.error?.message ?? "");
		const lines = text.length === 0 ? [] : text.split("\n");
		const total = lines.length;
		const window =
			request.format === "tail"
				? lines.slice(-(request.limit ?? 20))
				: lines.slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? total));
		const offset = request.format === "tail" ? total - window.length : (request.offset ?? 0);
		return { ref: entry.ref, text: window.join("\n"), offset, total, truncated: window.length < total };
	}

	/** Aborts every in-flight completion and closes every watch; afterwards every ref is stale. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const entry of this.#entries.values()) {
			if (entry.timer !== undefined) clearTimeout(entry.timer);
			if (!TERMINAL.has(entry.phase)) {
				entry.phase = "lost";
				entry.hostStatus = "session-dropped";
				entry.controller.abort(new Error("session generation dropped"));
			}
		}
		for (const queue of this.#watches) queue.close();
		this.#watches.clear();
	}

	#assertLive(): void {
		if (this.#disposed) throw new EvalHandleError("eval_handle_stale", "this session generation was dropped");
	}

	#fence(ref: HandleRef): CompletionEntry {
		this.#assertLive();
		const entry = this.#entries.get(ref.id);
		if (ref.kind !== "completion" || !entry)
			throw new EvalHandleError("eval_handle_not_found", `no completion handle ${ref.id}`);
		if (ref.run_epoch !== entry.ref.run_epoch)
			throw new EvalHandleError("eval_handle_stale", `${ref.id} run epoch ${ref.run_epoch} is not live`);
		return entry;
	}

	#settle(
		entry: CompletionEntry,
		next: { phase: HandlePhase; hostStatus: string; value?: unknown; error?: HandleError },
	): void {
		if (TERMINAL.has(entry.phase)) return;
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.phase = next.phase;
		entry.hostStatus = next.hostStatus;
		if ("value" in next) entry.value = next.value;
		if (next.error) entry.error = next.error;
		entry.revision += 1;
		const snapshot = snapshotOf(entry);
		for (const queue of this.#watches) queue.push(snapshot);
	}
}

function snapshotOf(entry: CompletionEntry): HandleSnapshot {
	return { ref: entry.ref, phase: entry.phase, host_status: entry.hostStatus, revision: entry.revision };
}

function toHandleError(error: unknown, timedOut: boolean): HandleError {
	if (timedOut) return { code: "completion_deadline", message: DEADLINE_MESSAGE };
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "string" ? error.code : "completion_failed";
		return { code, message: error.message };
	}
	return { code: "completion_failed", message: String(error) };
}
