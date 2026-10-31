/**
 * The server side of the reverse bridge (senpi#3566 todo 7). Each `host_call` from the child is admitted on receipt
 * against its job's capacity - the same one the child enforces - and run, queued FIFO, or refused with
 * `host_call_refused` naming its `callId`; every admitted call is answered exactly once with `host_reply`. A job that
 * ends signals its running calls and answers its queued calls without running them.
 */
import { HostCallAdmission } from "./admission.ts";
import type { ToolChildChannel } from "./channel.ts";
import type { PayloadRefReader, PayloadRefWriter } from "./payload-ref.ts";
import { packPayload, unpackPayload } from "./payload-wire.ts";
import type { HostCallKind, ToolChildMessage, ToolChildMessageOf } from "./protocol.ts";

/** The side's ref writer (payloads it sends) and reader (payloads it receives); absent = inline only. */
export interface HostCallRefs {
	readonly writer: PayloadRefWriter;
	readonly reader: PayloadRefReader;
}

export interface HostCallRequest {
	readonly callId: string;
	readonly jobId: string;
	readonly kind: HostCallKind;
	readonly name: string | undefined;
	readonly args: unknown;
	readonly signal: AbortSignal;
	/** What the job's dispatcher attached to it (the calling tool call, for a session); undefined when none. */
	readonly context: unknown;
	/** The child generation the call came from: whether its job is still live, and when the child's exit is observed. */
	readonly generation: HostCallGeneration;
}

/** What a handler may know about the generation a call came from (file locks are held per generation). */
export interface HostCallGeneration {
	/** Settles once the child that made the call has exited (observed by the server). */
	readonly exited: Promise<void>;
	/** Whether the calling job is still live (the server has not settled it). */
	readonly jobLive: () => boolean;
	/**
	 * Settles, with the holder's name, if the calling job becomes stuck: it outlived its deadline and grace and nothing
	 * can stop it (an in-process module). Its locks stay held, and every waiter on them fails fast. A child job never
	 * gets stuck - its process is killed - so this is unset there.
	 */
	readonly stuck?: Promise<string>;
}

/** The generation facts ServerHostCalls hands each request. */
export interface HostCallScope {
	readonly exited: Promise<void>;
	readonly jobLive: (jobId: string) => boolean;
}

const UNSCOPED: HostCallScope = { exited: new Promise(() => {}), jobLive: () => true };

export type HostCallHandler = (request: HostCallRequest) => Promise<unknown>;

/** The job context a request carries; ServerHostCalls reads it per call. */
export type HostCallContextOf = (jobId: string) => unknown;

interface ServerCall {
	readonly frame: ToolChildMessageOf<"host_call">;
	readonly abort: AbortController;
}

/** Calls `run` now, in this turn; a synchronous throw becomes a rejection like an async one. */
function settleNow<T>(run: () => T | Promise<T>): Promise<T> {
	try {
		return Promise.resolve(run());
	} catch (error) {
		return Promise.reject(error);
	}
}

export class ServerHostCalls {
	readonly #channel: Pick<ToolChildChannel, "send">;
	readonly #handler: HostCallHandler;
	readonly #admissions = new Map<string, HostCallAdmission>();
	readonly #calls = new Map<string, ServerCall>();

	readonly #contextOf: HostCallContextOf;
	readonly #refs: HostCallRefs | undefined;
	readonly #scope: HostCallScope;

	constructor(
		channel: Pick<ToolChildChannel, "send">,
		handler: HostCallHandler,
		contextOf: HostCallContextOf = () => undefined,
		refs?: HostCallRefs,
		scope: HostCallScope = UNSCOPED,
	) {
		this.#refs = refs;
		this.#scope = scope;
		this.#channel = channel;
		this.#handler = handler;
		this.#contextOf = contextOf;
	}

	/** Calls running and queued for one job (0 for a job with none). */
	load(jobId: string): { active: number; waiting: number } {
		const admission = this.#admissions.get(jobId);
		return { active: admission?.active ?? 0, waiting: admission?.waiting ?? 0 };
	}

	/** Takes a `host_call`; returns false for every other frame. */
	handle(frame: ToolChildMessage): boolean {
		if (frame.type !== "host_call") return false;
		const decision = this.#admission(frame.jobId).submit(frame.callId);
		if (decision.state === "refused") {
			this.#forgetIdle(frame.jobId);
			this.#channel.send(decision.frame);
			return true;
		}
		this.#calls.set(frame.callId, { frame, abort: new AbortController() });
		if (decision.state === "active") this.#run(frame.callId);
		return true;
	}

	/** The job ended: its running calls are signalled, its queued calls are answered without running. */
	endJob(jobId: string): void {
		for (const call of this.#calls.values()) if (call.frame.jobId === jobId) call.abort.abort();
	}

	#admission(jobId: string): HostCallAdmission {
		let admission = this.#admissions.get(jobId);
		if (admission === undefined) {
			admission = new HostCallAdmission();
			this.#admissions.set(jobId, admission);
		}
		return admission;
	}

	#forgetIdle(jobId: string): void {
		const admission = this.#admissions.get(jobId);
		if (admission !== undefined && admission.active === 0 && admission.waiting === 0) this.#admissions.delete(jobId);
	}

	#run(callId: string): void {
		const call = this.#calls.get(callId);
		if (call === undefined) return;
		const { frame } = call;
		const label = frame.name ?? frame.kind;
		const invoke = (args: unknown) =>
			this.#handler({
				callId,
				jobId: frame.jobId,
				kind: frame.kind,
				name: frame.name,
				args,
				signal: call.abort.signal,
				context: this.#contextOf(frame.jobId),
				generation: { exited: this.#scope.exited, jobLive: () => this.#scope.jobLive(frame.jobId) },
			});
		const answered = call.abort.signal.aborted
			? this.#refuseArgs(frame).then(() => Promise.reject(new Error(`${label}: the job ended before this call ran`)))
			: frame.argsRef === undefined
				? // Inline arguments start the handler in this turn, as admission promised; only a ref waits on its read.
					settleNow(() => invoke(frame.args))
				: this.#args(frame, call.abort.signal).then(invoke);
		void answered.then(
			(value) => void this.#reply(callId, value ?? null),
			(error: unknown) =>
				this.#answer(callId, {
					type: "host_reply",
					callId,
					error: error instanceof Error ? error.message : String(error),
				}),
		);
	}

	/** The call's arguments: inline, or a child-written ref accepted (acked, now owned here) and consumed. */
	async #args(frame: ToolChildMessageOf<"host_call">, signal: AbortSignal): Promise<unknown> {
		if (frame.argsRef === undefined) return frame.args;
		if (this.#refs === undefined) throw new Error("host_call carried argsRef but this side reads no refs");
		return unpackPayload(frame.argsRef, this.#refs.reader, signal);
	}

	/** A call whose job ended before it ran never opens its ref: the child's file is nacked and deleted by its writer. */
	async #refuseArgs(frame: ToolChildMessageOf<"host_call">): Promise<void> {
		if (frame.argsRef !== undefined) this.#refs?.reader.refuse(frame.argsRef, "cancelled");
	}

	/** A reply above the inline threshold travels as a server-written ref the child acks and then owns. */
	async #reply(callId: string, value: unknown): Promise<void> {
		try {
			const packed =
				this.#refs === undefined ? { inline: true as const, value } : await packPayload(value, this.#refs.writer);
			this.#answer(
				callId,
				packed.inline
					? { type: "host_reply", callId, value: packed.value }
					: { type: "host_reply", callId, valueRef: packed.ref },
			);
		} catch (error) {
			this.#answer(callId, {
				type: "host_reply",
				callId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#answer(callId: string, reply: ToolChildMessageOf<"host_reply">): void {
		const call = this.#calls.get(callId);
		if (call === undefined) return;
		this.#calls.delete(callId);
		this.#channel.send(reply);
		const { jobId } = call.frame;
		const promoted = this.#admissions.get(jobId)?.settle(callId);
		this.#forgetIdle(jobId);
		if (promoted !== undefined) this.#run(promoted);
	}
}
