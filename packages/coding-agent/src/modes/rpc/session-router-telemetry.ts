/**
 * The host's side of senpi#7446: which connections are callers of a session and what each answered. The rule they
 * feed is `core/telemetry-consent.ts`; this module only records answers and hands the session the result.
 *
 * Fail closed: a change is computed on a copy and kept only after the session confirmed the verdict it produces (an
 * in-process runtime takes it synchronously, a worker acknowledges it). A change the session did not confirm is not
 * kept and the caller gets a typed refusal; a worker that did not confirm a stricter verdict is ended, so nothing it
 * still holds is collected or delivered.
 */
import {
	openingCallersVerdict,
	SessionTelemetryCallers,
	type TelemetryCallersVerdict,
	type TelemetryConsent,
} from "../../core/telemetry-consent.ts";
import { sessionTelemetryConsentError } from "./rpc-input-validation.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";

/** A malformed telemetry answer on `open_session`, `attach_session` or `set_telemetry_consent`. */
export const RPC_ERROR_INVALID_TELEMETRY_CONSENT = "invalid_telemetry_consent";
/** The session did not confirm the verdict a telemetry change produces; the change was not kept. */
export const RPC_ERROR_TELEMETRY_UPDATE_UNCONFIRMED = "telemetry_update_unconfirmed";

/** `answer`: the open of a new session, or a deliberate change; `attach`: a caller joining a live session. */
export type TelemetryDeclarationKind = "answer" | "attach";

/** One session's callers, the verdict its session last confirmed, and the queue that orders their changes. */
export class SessionTelemetryState {
	callers: SessionTelemetryCallers;
	confirmed: TelemetryCallersVerdict;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(standing: TelemetryConsent) {
		this.callers = new SessionTelemetryCallers(standing);
		this.confirmed = openingCallersVerdict(standing);
	}

	/** Changes run one at a time, so a change never starts from a copy another change is about to replace. */
	serially<T>(change: () => Promise<T>): Promise<T> {
		const next = this.queue.then(change, change);
		this.queue = next.catch(() => undefined);
		return next;
	}
}

function stateOf(entry: RpcSessionEntry): SessionTelemetryState {
	entry.telemetry ??= new SessionTelemetryState(entry.profile.telemetryConsent ?? "unanswered");
	return entry.telemetry;
}

function sameVerdict(left: TelemetryCallersVerdict, right: TelemetryCallersVerdict): boolean {
	return left.events === right.events && left.attribution === right.attribution;
}

/** Whether `next` withdraws a use `confirmed` permits. */
function tightens(confirmed: TelemetryCallersVerdict, next: TelemetryCallersVerdict): boolean {
	return (confirmed.events && !next.events) || (confirmed.attribution && !next.attribution);
}

/**
 * How long a worker has to acknowledge a STRICTER verdict before the host ends it (senpi#7446). This bounds the window
 * in which a worker can still collect or export under the use its callers withdrew.
 */
export const TELEMETRY_REVOKE_ACK_MS = 2_000;
/** How long the host waits to OBSERVE an ended worker's exit before it reports the end as unconfirmed. */
export const TELEMETRY_END_CONFIRM_MS = 2_000;

/** `confirmed`: the session runs the verdict. `ended`: the host observed the worker gone. `unconfirmed`: neither. */
export type TelemetryOutcome = "confirmed" | "ended" | "unconfirmed";

function within<T>(promise: Promise<T>, ms: number): Promise<T | "deadline"> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve("deadline"), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(cause: unknown) => {
				clearTimeout(timer);
				reject(cause);
			},
		);
	});
}

/**
 * Hands the session `verdict`. An in-process runtime takes it synchronously. A worker must acknowledge it; one that
 * refuses, fails or misses the deadline on a STRICTER verdict is ended, and the end counts only once its exit is seen.
 * A looser verdict it did not acknowledge leaves it on its stricter, confirmed one.
 */
async function deliver(
	entry: RpcSessionEntry,
	confirmed: TelemetryCallersVerdict,
	verdict: TelemetryCallersVerdict,
): Promise<TelemetryOutcome> {
	if (entry.runtime) {
		// A stand-in runtime without the hook cannot run the verdict, so the change is not confirmed.
		if (typeof entry.runtime.setTelemetryCallers !== "function") return "unconfirmed";
		entry.runtime.setTelemetryCallers(verdict);
		return "confirmed";
	}
	const worker = entry.worker;
	if (!worker) return "confirmed";
	const withdraws = tightens(confirmed, verdict);
	const acknowledged = worker.setTelemetryCallers(verdict).then(
		() => true,
		(cause: unknown) => {
			process.stderr.write(`senpi rpc telemetry verdict refused by its worker: ${String(cause)}\n`);
			return false;
		},
	);
	const answer = withdraws ? await within(acknowledged, TELEMETRY_REVOKE_ACK_MS) : await acknowledged;
	if (answer === true) return "confirmed";
	if (!withdraws) return "unconfirmed";
	worker.failClosed(RPC_ERROR_TELEMETRY_UPDATE_UNCONFIRMED);
	return (await within(worker.exited, TELEMETRY_END_CONFIRM_MS)) === "deadline" ? "unconfirmed" : "ended";
}

/**
 * Applies `change` to a copy and delivers the verdict if it moved. The answers that WITHDRAW a use are recorded on the
 * host at once (a revocation is never lost to a slow worker); the verdict the session runs is recorded only once it is
 * confirmed, or once the worker is seen to have ended, so the host never reports "off" it cannot prove. An answer that
 * only adds a use is recorded only once the session confirmed it, so an unconfirmed grant stays off.
 */
function transition(
	entry: RpcSessionEntry,
	change: (callers: SessionTelemetryCallers) => void,
): Promise<TelemetryOutcome> {
	const state = stateOf(entry);
	return state.serially(async () => {
		const next = state.callers.copy();
		change(next);
		const previous = state.confirmed;
		const verdict = next.verdict();
		const keepAnswers = (): void => {
			state.callers = next;
			const telemetryConsent = next.standingConsent();
			if (telemetryConsent !== undefined && telemetryConsent !== entry.profile.telemetryConsent)
				entry.profile = Object.freeze({ ...entry.profile, telemetryConsent });
		};
		if (sameVerdict(verdict, previous)) {
			keepAnswers();
			return "confirmed";
		}
		const withdraws = tightens(previous, verdict);
		if (withdraws) keepAnswers();
		const outcome = await deliver(entry, previous, verdict);
		if (outcome === "unconfirmed") return outcome;
		if (!withdraws) keepAnswers();
		state.confirmed = verdict;
		return outcome;
	});
}

/**
 * A connection became a caller of `sessionId` with this answer (silence is `unanswered`). Anything but `confirmed`
 * means the answer is not in effect as a running policy, and the caller must not be reported attached.
 */
export async function declareTelemetry(
	host: RouterContext,
	sessionId: string,
	connection: string | undefined,
	consent: TelemetryConsent | undefined,
	kind: TelemetryDeclarationKind,
): Promise<TelemetryOutcome> {
	if (connection === undefined) return "confirmed";
	const entry = host.registry.peek(sessionId);
	if (entry?.state !== "open") return "confirmed";
	return transition(entry, (callers) => callers[kind](connection, consent ?? "unanswered"));
}

/** A connection is no longer attached to `sessionId`: its live answer leaves with it. */
export function telemetryCallerLeft(host: RouterContext, sessionId: string, connection: string): void {
	const entry = host.registry.peek(sessionId);
	if (entry?.state !== "open" || entry.telemetry === undefined) return;
	// Leaving only removes an answer, so an unconfirmed result leaves the session on its stricter, confirmed verdict.
	void transition(entry, (callers) => callers.leave(connection));
}

/**
 * The typed refusal for an answer the session did not run. `workerEnded` is true only when the host observed the
 * session's worker gone (nothing is collected or delivered any more); false means the end, if requested, is unproven.
 */
export function telemetryUnconfirmed(
	id: string | undefined,
	command: string,
	sessionId: string,
	outcome: Exclude<TelemetryOutcome, "confirmed">,
): RpcResponse {
	return error(id, command, RPC_ERROR_TELEMETRY_UPDATE_UNCONFIRMED, {
		sessionId,
		workerEnded: outcome === "ended",
		reason: "the session did not confirm the telemetry policy this answer produces",
		action:
			"a stricter answer ends a session that could not confirm it; a looser one leaves its stricter policy, retry",
	});
}

/** `set_telemetry_consent`: only a connection attached to the session answers for it. */
export async function setTelemetryConsent(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "set_telemetry_consent" }>,
): Promise<RpcResponse> {
	const invalid = sessionTelemetryConsentError(command.consent);
	if (invalid !== undefined)
		return error(command.id, command.type, RPC_ERROR_INVALID_TELEMETRY_CONSENT, { reason: invalid });
	const connection = host.writer.currentConnection();
	if (connection === undefined || host.sessionsByConnection.get(connection)?.has(command.sessionId) !== true)
		return error(command.id, command.type, "session_not_attached", {
			reason: "this connection is not attached to that session",
			action: "attach first with attach_session or open_session, then answer",
		});
	try {
		host.registry.getForCommand(command.sessionId, command.type);
		const outcome = await declareTelemetry(host, command.sessionId, connection, command.consent, "answer");
		if (outcome !== "confirmed") return telemetryUnconfirmed(command.id, command.type, command.sessionId, outcome);
		return { id: command.id, type: "response", command: command.type, success: true };
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause));
	}
}
