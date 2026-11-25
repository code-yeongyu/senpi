/**
 * The host's side of senpi#7446: which connections are callers of a session and what each answered. The rule they
 * feed is `core/telemetry-consent.ts`; this module only records answers and hands the session the result.
 *
 * Fail closed: a change is computed on a copy and kept only after the session confirmed the verdict it produces (an
 * in-process runtime takes it synchronously, a worker acknowledges it). A change the session did not confirm is not
 * kept, so the host's record never claims a policy the session is not running, and the caller gets a typed refusal.
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

/** True once the session runs `verdict`. A session with neither a runtime nor a worker runs nothing. */
async function confirm(entry: RpcSessionEntry, verdict: TelemetryCallersVerdict): Promise<boolean> {
	if (entry.runtime) {
		// A stand-in runtime without the hook cannot run the verdict, so the change is not confirmed.
		if (typeof entry.runtime.setTelemetryCallers !== "function") return false;
		entry.runtime.setTelemetryCallers(verdict);
		return true;
	}
	if (!entry.worker) return true;
	try {
		await entry.worker.setTelemetryCallers(verdict);
		return true;
	} catch (cause) {
		process.stderr.write(`senpi rpc telemetry verdict not confirmed by its worker: ${String(cause)}\n`);
		return false;
	}
}

/** Applies `change` to a copy, delivers the verdict if it moved, and keeps the copy only when it was confirmed. */
function transition(entry: RpcSessionEntry, change: (callers: SessionTelemetryCallers) => void): Promise<boolean> {
	const state = stateOf(entry);
	return state.serially(async () => {
		const next = state.callers.copy();
		change(next);
		const verdict = next.verdict();
		if (!sameVerdict(verdict, state.confirmed)) {
			if (!(await confirm(entry, verdict))) return false;
			state.confirmed = verdict;
		}
		state.callers = next;
		const telemetryConsent = next.standingConsent();
		if (telemetryConsent !== undefined && telemetryConsent !== entry.profile.telemetryConsent)
			entry.profile = Object.freeze({ ...entry.profile, telemetryConsent });
		return true;
	});
}

/**
 * A connection became a caller of `sessionId` with this answer (silence is `unanswered`). False when the session did
 * not confirm the result: the answer was not kept, and the caller must not be reported attached.
 */
export async function declareTelemetry(
	host: RouterContext,
	sessionId: string,
	connection: string | undefined,
	consent: TelemetryConsent | undefined,
	kind: TelemetryDeclarationKind,
): Promise<boolean> {
	if (connection === undefined) return true;
	const entry = host.registry.peek(sessionId);
	if (entry?.state !== "open") return true;
	return transition(entry, (callers) => callers[kind](connection, consent ?? "unanswered"));
}

/** A connection is no longer attached to `sessionId`: its live answer leaves with it. */
export function telemetryCallerLeft(host: RouterContext, sessionId: string, connection: string): void {
	const entry = host.registry.peek(sessionId);
	if (entry?.state !== "open" || entry.telemetry === undefined) return;
	// Leaving only removes an answer, so an unconfirmed result leaves the session on its stricter, confirmed verdict.
	void transition(entry, (callers) => callers.leave(connection));
}

/** The typed refusal for an answer the session did not confirm. */
export function telemetryUnconfirmed(id: string | undefined, command: string, sessionId: string): RpcResponse {
	return error(id, command, RPC_ERROR_TELEMETRY_UPDATE_UNCONFIRMED, {
		sessionId,
		reason: "the session did not confirm the telemetry policy this answer produces",
		action: "retry; until it succeeds the session keeps its previous policy",
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
		if (!(await declareTelemetry(host, command.sessionId, connection, command.consent, "answer")))
			return telemetryUnconfirmed(command.id, command.type, command.sessionId);
		return { id: command.id, type: "response", command: command.type, success: true };
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause));
	}
}
