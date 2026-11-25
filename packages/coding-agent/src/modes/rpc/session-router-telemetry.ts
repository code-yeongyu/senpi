/**
 * The host's side of senpi#7446: which connections are callers of a session and what each answered. The rule they
 * feed is `core/telemetry-consent.ts`; this module only records answers and hands the session the result.
 */
import { SessionTelemetryCallers, type TelemetryConsent } from "../../core/telemetry-consent.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";

/** `answer`: the open of a new session, or a deliberate change; `attach`: a caller joining a live session. */
export type TelemetryDeclarationKind = "answer" | "attach";

function callersOf(entry: RpcSessionEntry): SessionTelemetryCallers {
	entry.telemetryCallers ??= new SessionTelemetryCallers(entry.profile.telemetryConsent ?? "unanswered");
	return entry.telemetryCallers;
}

/** Hands the session the callers' half of its decision, and keeps the standing answer a reopen replays. */
async function publish(entry: RpcSessionEntry, callers: SessionTelemetryCallers): Promise<void> {
	const telemetryConsent = callers.standingConsent();
	if (telemetryConsent !== undefined && telemetryConsent !== entry.profile.telemetryConsent)
		entry.profile = Object.freeze({ ...entry.profile, telemetryConsent });
	const permit = callers.permit();
	entry.runtime?.setTelemetryCallersPermit(permit);
	await entry.worker?.setTelemetryCallersPermit(permit);
}

/** A connection became a caller of `sessionId` with this answer; silence is `unanswered`. */
export async function declareTelemetry(
	host: RouterContext,
	sessionId: string,
	connection: string | undefined,
	consent: TelemetryConsent | undefined,
	kind: TelemetryDeclarationKind,
): Promise<void> {
	if (connection === undefined) return;
	const entry = host.registry.peek(sessionId);
	if (entry?.state !== "open") return;
	const callers = callersOf(entry);
	callers[kind](connection, consent ?? "unanswered");
	await publish(entry, callers);
}

/** A connection is no longer attached to `sessionId`: its live answer leaves with it. */
export function telemetryCallerLeft(host: RouterContext, sessionId: string, connection: string): void {
	const entry = host.registry.peek(sessionId);
	const callers = entry?.telemetryCallers;
	if (entry?.state !== "open" || callers === undefined) return;
	callers.leave(connection);
	void publish(entry, callers).catch((cause: unknown) => {
		process.stderr.write(`senpi rpc telemetry permit for session ${sessionId} not delivered: ${String(cause)}\n`);
	});
}

/** `set_telemetry_consent`: only a connection attached to the session answers for it. */
export async function setTelemetryConsent(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "set_telemetry_consent" }>,
): Promise<RpcResponse> {
	const connection = host.writer.currentConnection();
	if (connection === undefined || host.sessionsByConnection.get(connection)?.has(command.sessionId) !== true)
		return error(command.id, command.type, "session_not_attached", { reason: "not_attached" });
	try {
		host.registry.getForCommand(command.sessionId, command.type);
		await declareTelemetry(host, command.sessionId, connection, command.consent, "answer");
		return { id: command.id, type: "response", command: command.type, success: true };
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause));
	}
}
