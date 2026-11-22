/**
 * The host calls of an in-process module (senpi#3622), answered by the session's host-call handler under the rules the
 * child's `ServerHostCalls` applies, so a module behaves the same on both runtimes.
 */
import { HostCallAdmission } from "../../modes/rpc/tool-child/admission.ts";
import type { HostCallHandler } from "../../modes/rpc/tool-child/host-calls-server.ts";
import { createModuleHost, type ModuleHost } from "../../modes/rpc/tool-child/module-host.ts";
import type { HostCallKind } from "../../modes/rpc/tool-child/protocol.ts";
import { OffloadError } from "./offload.ts";
import type { ToolChildModuleJob } from "./tool-dispatcher.ts";

/** A call a module makes in-process, admitted like the child's (`HostCallAdmission`): running, queued FIFO, or refused. */
interface InProcessCall {
	readonly abort: AbortController;
	readonly start: () => void;
}

/** A refused or unrun in-process call: the same codes a child's caller reads from `.code`. */
export class InProcessHostCallError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "InProcessHostCallError";
		this.code = code;
	}
}

export interface InProcessHostCalls {
	readonly host: ModuleHost;
	stopAdmitting(): void;
	/** The session closed: every further call is refused `host_call_session_closed`, and calls running are signalled. */
	close(): void;
	/** Ends the job: running calls are signalled and every lock it holds is released. */
	end(): void;
	ended(): boolean;
	heldFiles(): string[];
	markStuck(holder: string): void;
}

/**
 * The host an in-process module gets, its calls answered by the session's host-call handler under the same rules the
 * child's `ServerHostCalls` applies: one admission per job, the job's cancel signalled into every call except the lock
 * calls (a lock is released after the writes stop, not when the cancel arrives), and every call still running signalled
 * when the job ends. `end` resolves the generation's `exited`, which releases the locks the job still holds;
 * `markStuck` resolves its `stuck`, which keeps them held and fails every waiter on them.
 */
export function inProcessHostCalls(
	job: ToolChildModuleJob,
	cancelled: AbortSignal,
	hostCalls: HostCallHandler | undefined,
): InProcessHostCalls {
	let admitting = true;
	let closed = false;
	let ended = false;
	let settleExited: () => void = () => {};
	const exited = new Promise<void>((resolveExited) => {
		settleExited = resolveExited;
	});
	let settleStuck: (holder: string) => void = () => {};
	const stuck = new Promise<string>((resolveStuck) => {
		settleStuck = resolveStuck;
	});
	const admission = new HostCallAdmission();
	const calls = new Map<string, InProcessCall>();
	const held = new Map<string, string>();
	const jobId = `in-process:${job.modulePath}#${job.export}`;
	let next = 0;
	const answer = (kind: HostCallKind, name: string | undefined, args: unknown): Promise<unknown> => {
		if (hostCalls === undefined)
			return Promise.reject(
				new OffloadError("tool_runtime_unavailable", `${kind}: this session answers no host calls`),
			);
		if (closed)
			return Promise.reject(
				new InProcessHostCallError("host_call_session_closed", `${name ?? kind}: the session was closed`),
			);
		const callId = `ip${++next}`;
		const decision = admission.submit(callId);
		if (decision.state === "refused")
			return Promise.reject(new InProcessHostCallError(decision.frame.code, `${name ?? kind}: refused`));
		const abort = new AbortController();
		const forward = () => abort.abort(cancelled.reason);
		const survivesCancel = kind === "lock_file" || kind === "unlock_file";
		if (!survivesCancel) {
			if (cancelled.aborted) forward();
			else cancelled.addEventListener("abort", forward, { once: true });
		}
		return new Promise<unknown>((resolve, reject) => {
			const start = () => {
				const answered = abort.signal.aborted
					? Promise.reject(
							new InProcessHostCallError(
								"host_call_job_ended",
								`${name ?? kind}: the job ended before this call ran`,
							),
						)
					: settleNow(() =>
							hostCalls({
								callId,
								jobId,
								kind,
								name,
								args,
								signal: abort.signal,
								context: { toolCallId: callingToolCallId(job.args) },
								generation: { exited, stuck, jobLive: () => admitting && !ended },
							}),
						);
				void answered.then(resolve, reject).finally(() => {
					calls.delete(callId);
					cancelled.removeEventListener("abort", forward);
					const promoted = admission.settle(callId);
					if (promoted !== undefined) calls.get(promoted)?.start();
				});
			};
			calls.set(callId, { abort, start });
			if (decision.state === "active") start();
		});
	};
	const host = createModuleHost(cancelled, async (kind, name, args) => {
		const value = await answer(kind, name, args);
		// Only an answered unlock lets go of the file: a refused one leaves it held, and named in a stuck notice.
		if (kind === "unlock_file") {
			const lockId = stringOf(args, "lockId");
			if (lockId !== undefined) held.delete(lockId);
		}
		if (kind === "lock_file") {
			const lockId = stringOf(value, "lockId");
			const path = stringOf(args, "path");
			if (lockId !== undefined && path !== undefined) held.set(lockId, path);
		}
		return value;
	});
	return {
		host,
		stopAdmitting: () => {
			admitting = false;
		},
		close: () => {
			closed = true;
			admitting = false;
			for (const call of calls.values()) call.abort.abort();
		},
		ended: () => ended,
		heldFiles: () => [...new Set(held.values())],
		markStuck: (holder) => settleStuck(holder),
		end: () => {
			if (ended) return;
			ended = true;
			held.clear();
			for (const call of calls.values()) call.abort.abort();
			settleExited();
		},
	};
}

function stringOf(value: unknown, field: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const found: unknown = Reflect.get(value, field);
	return typeof found === "string" ? found : undefined;
}

/** Calls `run` now; a synchronous throw becomes a rejection like an async one. */
export function settleNow<T>(run: () => T | Promise<T>): Promise<T> {
	try {
		return Promise.resolve(run());
	} catch (error) {
		return Promise.reject(error);
	}
}

function callingToolCallId(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const toolCallId: unknown = Reflect.get(args, "toolCallId");
	return typeof toolCallId === "string" ? toolCallId : undefined;
}
