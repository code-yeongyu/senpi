import {
	SUMMARIZATION_MAX_DURATION_CAP_MS,
	SUMMARIZATION_TOTAL_BUDGET_MS,
} from "../../core/compaction/stream-watchdog.ts";
import { ABORT_DEFAULT_GRACE_MS, isAbortGraceInRange } from "./abort-grace.ts";

/** How long any request waits for the host's answer - for an open, for its `queued` acknowledgement. */
export const REQUEST_DEADLINE_MS = 30_000;

/**
 * How long one request may wait for its answer before the client gives up. An awaited abort answers only
 * after the turn stopped or its `graceMs` ran out (up to 60 s), so its wait is that grace plus the
 * ordinary allowance; every other command keeps the plain request deadline. A `graceMs` the host would
 * refuse (out of range, fractional, NaN, Infinity) gets the plain deadline too: the host answers it at once
 * with `invalid_argument`, and the client must still be listening for that refusal.
 */
export function requestDeadlineMs(command: {
	readonly type: string;
	readonly awaitIdle?: unknown;
	readonly graceMs?: unknown;
}): number {
	if (command.type !== "abort" || command.awaitIdle !== true) return REQUEST_DEADLINE_MS;
	if (command.graceMs === undefined) return ABORT_DEFAULT_GRACE_MS + REQUEST_DEADLINE_MS;
	return isAbortGraceInRange(command.graceMs) ? command.graceMs + REQUEST_DEADLINE_MS : REQUEST_DEADLINE_MS;
}

/** Remote compaction may exhaust its budget before a local summary uses its maximum override. */
export const PROMPT_COMPACTION_DEADLINE_MS =
	SUMMARIZATION_TOTAL_BUDGET_MS + SUMMARIZATION_MAX_DURATION_CAP_MS + REQUEST_DEADLINE_MS;

/**
 * The longest a prompt waits for its acknowledgement, however many compactions start and end while it
 * is pending: one full compaction budget plus the ordinary allowance it may already have spent first.
 */
export const PROMPT_ACK_MAX_WAIT_MS = PROMPT_COMPACTION_DEADLINE_MS + REQUEST_DEADLINE_MS;

/**
 * How long an open the host acknowledged with `queued` may take to answer. The host is building the
 * session on its loop, which on a loaded in-process host was measured at ~57 s; a lost transport
 * still rejects at once, so this ceiling only bounds a host that accepted and then went silent
 * (senpi#2209).
 */
export const OPEN_AFTER_QUEUED_DEADLINE_MS = 10 * 60_000;

/**
 * How long a prompt the host acknowledged as received may take to be accepted. Its preflight runs on the
 * session's loop, which on a starved shared host outlived the 30 s request deadline: the client gave up,
 * discarded the session, and the host answered into its closed scope (senpi#2871). A lost transport still
 * rejects at once; this only bounds a host that received the prompt and then went silent.
 */
export const PROMPT_AFTER_QUEUED_DEADLINE_MS = 5 * 60_000;

export function promptStalledMessage(): string {
	return `prompt was received by the host but not accepted within ${PROMPT_AFTER_QUEUED_DEADLINE_MS / 60_000} minutes`;
}

export function openStalledMessage(position: unknown): string {
	const queued = typeof position === "number" ? ` at queue position ${position}` : "";
	const minutes = OPEN_AFTER_QUEUED_DEADLINE_MS / 60_000;
	return `open_session was accepted by the host${queued} but not answered within ${minutes} minutes`;
}

/** A request the host did not answer within its deadline: the host is not responding on this connection. */
export class RpcRequestTimeoutError extends Error {
	readonly code = "rpc_request_timeout" as const;

	constructor(message: string) {
		super(message);
		this.name = "RpcRequestTimeoutError";
	}
}

export interface RequestDeadline {
	/** Restarts the wait with a new budget and the message it fails with. */
	extend(ms: number, message: () => string): void;
	clear(): void;
}

export function armRequestDeadline(ms: number, message: () => string, expire: (error: Error) => void): RequestDeadline {
	let timer = setTimeout(() => expire(new RpcRequestTimeoutError(message())), ms);
	return {
		extend(nextMs, nextMessage) {
			clearTimeout(timer);
			timer = setTimeout(() => expire(new RpcRequestTimeoutError(nextMessage())), nextMs);
		},
		clear() {
			clearTimeout(timer);
		},
	};
}
