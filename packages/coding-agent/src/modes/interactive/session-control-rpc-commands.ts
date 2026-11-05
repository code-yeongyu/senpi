/**
 * The host commands a terminal control endpoint serves for its own session (senpi#3229): `open_session`
 * attaches by path or id, `subscribe_sessions`/`unsubscribe_sessions` run the host's status stream over
 * this one session, `steer`/`follow_up`/`prompt` go through the session's external admission (the
 * terminal's one delivery authority, so the user's draft still holds them) with the host's `whenIdle`
 * meaning, and `get_effect_status` reads the same effect ledger. The rest of the host's drive set answers with the
 * host's contract (senpi#4267): `set_client_info` declares the connection's roles, `attach_session` and
 * `release_attachment` take and drop a live attachment on the session's identity, `abort` runs the host's effect
 * path and its role rule (a Stop needs `interactive_user`), and input sent with a `clientMessageId` is answered
 * with an admission receipt that a retry gets again, marked `replayed`. A frame this file does not own answers
 * `undefined` and falls through to the endpoint's other commands.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ExternalDeliverAs } from "../../core/extensions/session-control-types.ts";
import { CONNECTION_ROLE_FIXED } from "../rpc/connection-roles.ts";
import { INTERACTIVE_USER_CAPABILITY } from "../rpc/custom-capability.ts";
import { runAbort, runGetEffectStatus } from "../rpc/effect-commands.ts";
import { buildRpcSessionState } from "../rpc/rpc-session-state.ts";
import { getSnapshot } from "../rpc/get-snapshot.ts";
import type { RpcCommand } from "../rpc/rpc-types.ts";
import { answerSubscribeSessions, answerUnsubscribeSessions, refusal } from "../rpc/session-status-commands.ts";
import { type ControlAttachments, keyOf, type TerminalInputReceipt } from "./session-control-attach.ts";
import { type ControlCommand, type ControlConnection, failure, success } from "./session-control-server.ts";

type Command<T extends RpcCommand["type"]> = Extract<RpcCommand, { type: T }>;

export const TUI_RPC_COMMANDS = [
	"open_session",
	"get_snapshot",
	"subscribe_sessions",
	"unsubscribe_sessions",
	"steer",
	"follow_up",
	"prompt",
	"get_effect_status",
	"set_client_info",
	"attach_session",
	"release_attachment",
	"abort",
] as const;

/** The host's answer to a Stop from a connection that never declared the user's role (senpi#3811). */
const STOP_REQUIRES_INTERACTIVE_CLIENT =
	"stop_requires_interactive_client: declare interactive_user with set_client_info first";

export interface RpcCommandContext {
	/** This endpoint's instance id: the `expectedHostInstance` an `attach_session` may name. */
	readonly instanceId: string;
	readonly session: AgentSession;
	readonly attachments: ControlAttachments;
}

/** `null` = answered on the writer already; `undefined` = not a command this file owns. */
export async function runTuiRpcCommand(
	context: RpcCommandContext,
	connection: ControlConnection,
	command: ControlCommand,
): Promise<object | null | undefined> {
	switch (command.type) {
		case "get_snapshot": {
			const { attachments, session } = context;
			if (command.sessionId !== undefined && command.sessionId !== attachments.handle)
				return {
					id: command.id,
					type: "response",
					command: command.type,
					success: false,
					error: "unknown_session",
				};
			const snapshot = getSnapshot(
				session,
				{ tail: command.tail, maxBytes: command.maxBytes },
				{
					enqueue: (markerId) =>
						attachments.run(connection, () =>
							attachments.writer.enqueue(attachments.handle, { type: "snapshot_marker", markerId }),
						),
				},
			);
			return "error" in snapshot
				? { id: command.id, type: "response", command: command.type, success: false, error: snapshot.error }
				: answered(idOf(command), command.type, snapshot.data);
		}
		case "open_session":
			return openSession(context, connection, command);
		case "subscribe_sessions":
			return subscribe(context, connection, frame<"subscribe_sessions">(command));
		case "unsubscribe_sessions":
			return answerUnsubscribeSessions(
				frame<"unsubscribe_sessions">(command),
				keyOf(connection),
				context.attachments.writer.status,
			);
		case "steer":
		case "follow_up":
			return admitInput(context, command, command.type === "steer" ? "steer" : "followUp", command.whenIdle);
		case "prompt":
			return admitPrompt(context, command);
		case "set_client_info":
			return setClientInfo(context, connection, command);
		case "attach_session":
			return attachSession(context, connection, command);
		case "release_attachment":
			return releaseAttachment(context, connection, command);
		case "abort":
			return abort(context, connection, frame<"abort">(command));
		case "get_effect_status":
			return runGetEffectStatus(
				{
					session: context.session,
					by: { connectionId: keyOf(connection) },
					sessionId: context.attachments.handle,
				},
				frame<"get_effect_status">(command),
			);
		default:
			return undefined;
	}
}

/** The server checked the frame's shape (`rpcCommandShapeError`), as a host does before dispatching it. */
function frame<T extends RpcCommand["type"]>(command: ControlCommand): Command<T> {
	return command as unknown as Command<T>;
}

function idOf(command: ControlCommand): string | undefined {
	return typeof command.id === "string" ? command.id : undefined;
}

function openSession(
	context: RpcCommandContext,
	connection: ControlConnection,
	command: ControlCommand,
): object | null {
	const { session, attachments } = context;
	const ownPath = typeof command.sessionPath === "string" && samePath(command.sessionPath, session.sessionFile);
	const ownId = command.sessionId !== undefined && command.sessionId === session.sessionId;
	if (!ownPath && !ownId)
		return refusal(idOf(command), "open_session", "terminal_single_session", {
			reason: "this terminal hosts one session and the request names another",
			action: "open it by this terminal's sessionPath, or open the other session on a host",
		});
	attachments.run(connection, () => {
		attachments.attach(connection);
		attachments.writer.enqueue(attachments.handle, {
			id: command.id,
			type: "response",
			command: "open_session",
			success: true,
			data: { sessionId: attachments.handle, state: buildRpcSessionState(session), attached: true },
		});
	});
	return null;
}

/** Declares this connection's roles, fixed once declared, exactly as on a host; the other fields change nothing here. */
function setClientInfo(context: RpcCommandContext, connection: ControlConnection, command: ControlCommand): object {
	const capabilities = command.capabilities;
	if (capabilities === undefined) return success(command.id, "set_client_info");
	if (!Array.isArray(capabilities) || !capabilities.every((entry): entry is string => typeof entry === "string"))
		return failure(command.id, "set_client_info", "capabilities must be an array of strings");
	if (!context.attachments.roles.declare(keyOf(connection), capabilities))
		return failure(command.id, "set_client_info", CONNECTION_ROLE_FIXED);
	return success(command.id, "set_client_info");
}

/**
 * A live attachment on the session's identity, as on a host: `sessionId` is this terminal's routing handle,
 * `durableSessionId` its session id, and `expectedHostInstance`, when sent, this endpoint's instance id. The answer
 * follows the replay of the in-flight snapshot, then the session's records reach the connection.
 */
function attachSession(
	context: RpcCommandContext,
	connection: ControlConnection,
	command: ControlCommand,
): object | null {
	const { session, attachments } = context;
	const id = idOf(command);
	if (command.sessionId !== attachments.handle)
		return refusal(id, "attach_session", "unknown_session", {
			reason: "this terminal hosts one session and the request names another",
			action: "attach with this terminal's sessionId from list_sessions",
		});
	const instanceMatches =
		command.expectedHostInstance === undefined || command.expectedHostInstance === context.instanceId;
	if (command.durableSessionId !== session.sessionId || !instanceMatches)
		return refusal(id, "attach_session", "session_identity_mismatch", {
			reason: "durableSessionId or expectedHostInstance does not name this terminal's session",
			action: "read list_sessions and get_protocol_info again, then attach with their ids",
		});
	attachments.run(connection, () => {
		attachments.attach(connection);
		attachments.writer.enqueue(attachments.handle, {
			id: command.id,
			type: "response",
			command: "attach_session",
			success: true,
			data: { sessionId: attachments.handle, attached: true },
		});
	});
	return null;
}

function releaseAttachment(context: RpcCommandContext, connection: ControlConnection, command: ControlCommand): object {
	if (command.sessionId !== context.attachments.handle || !context.attachments.detach(connection))
		return refusal(idOf(command), "release_attachment", "session_not_attached", {
			reason: "this connection is not attached to that session",
			action: "attach first with attach_session or open_session",
		});
	// Nothing outlives the terminal's own attachment, so a release is never deferred.
	return success(command.id, "release_attachment", { deferred: false });
}

/** The host's `abort`: the same effect receipts, and a Stop only from a connection that declared `interactive_user`. */
async function abort(context: RpcCommandContext, connection: ControlConnection, command: Command<"abort">) {
	const key = keyOf(connection);
	if (command.intent === "stop" && !context.attachments.roles.has(key, INTERACTIVE_USER_CAPABILITY))
		return failure(command.id, "abort", STOP_REQUIRES_INTERACTIVE_CLIENT);
	const { session } = context;
	return runAbort({ session, by: { connectionId: key }, sessionId: context.attachments.handle }, command, () =>
		(command.intent === "stop" ? session.stop() : session.abort()).catch((cause: unknown) => {
			// Reported out of band, as on a host; the answer never waits on it.
			connection.send({ type: "rpc_error", error: String(cause) });
		}),
	);
}

function subscribe(context: RpcCommandContext, connection: ControlConnection, command: Command<"subscribe_sessions">) {
	const { writer } = context.attachments;
	const key = keyOf(connection);
	const { answer, activate } = answerSubscribeSessions(command, key, writer.status);
	if (activate === undefined) return answer;
	// As on a host: the answer reaches the connection's FIFO before the subscription goes live, so its
	// snapshot is the first record the client reads for this subscription.
	void writer
		.enqueueControl(answer, key)
		.then(() => {
			if (writer.hasConnection(key)) writer.status.activate(activate);
			else writer.status.unsubscribe(key, activate);
		})
		.catch(() => writer.status.unsubscribe(key, activate));
	return null;
}

function admitPrompt(context: RpcCommandContext, command: ControlCommand): object {
	const behavior = command.streamingBehavior;
	if (behavior === undefined && context.session.isStreaming)
		return refusal(idOf(command), "prompt", "session_busy", {
			reason: "a turn is running and the prompt names no streamingBehavior",
			action: 'send it with streamingBehavior "steer" or "followUp", or as a steer/follow_up',
		});
	return admitInput(context, command, behavior === "followUp" ? "followUp" : "steer", "start");
}

/** Input fields a host honours that admission cannot: refused by name instead of silently dropped. */
const UNSERVED_INPUT_FIELDS = [
	"images",
	"thinkingLevel",
	"expandPromptTemplates",
	"unknownCommandAsText",
	"sessionTitlePrompt",
	"enqueueOrder",
] as const;

function samePath(requested: string, own: string | undefined): boolean {
	if (own === undefined) return false;
	const canonical = (path: string): string => {
		try {
			return realpathSync(resolve(path));
		} catch {
			return resolve(path);
		}
	};
	return canonical(requested) === canonical(own);
}

function admitInput(
	context: RpcCommandContext,
	command: ControlCommand,
	deliverAs: ExternalDeliverAs,
	whenIdle: unknown,
): object {
	const id = idOf(command);
	const unserved = UNSERVED_INPUT_FIELDS.filter((field) => command[field] !== undefined);
	if (unserved.length > 0)
		return refusal(id, command.type, "unsupported_field", {
			reason: `a terminal delivers input through its admission, which carries text only, not ${unserved.join(", ")}`,
			action: "send the message without those fields, or send it to a host session",
		});
	const message = command.message;
	if (typeof message !== "string" || message.trim() === "")
		return refusal(id, command.type, "invalid_message", {
			reason: "message is empty",
			action: "send a non-empty message",
		});
	if (whenIdle !== undefined && whenIdle !== "queue" && whenIdle !== "start")
		return refusal(id, command.type, "invalid_when_idle", {
			reason: `whenIdle must be "queue" or "start", not ${JSON.stringify(whenIdle)}`,
			action: 'send whenIdle: "queue" (the default) or "start"',
		});
	const admission = context.session.externalAdmission;
	const clientMessageId = typeof command.clientMessageId === "string" ? command.clientMessageId : undefined;
	const fingerprint = JSON.stringify([command.type, message, deliverAs, whenIdle ?? null]);
	const prior = clientMessageId === undefined ? undefined : context.attachments.receipts.get(clientMessageId);
	if (prior !== undefined) {
		if (prior.fingerprint !== fingerprint)
			return refusal(id, command.type, "client_message_id_conflict", {
				reason: `clientMessageId ${clientMessageId} was already used for different input`,
				action: "send new input with a new clientMessageId",
			});
		return answered(id, command.type, {
			disposition: prior.disposition,
			clientMessageId,
			replayed: true,
			duplicate: true,
			admission: prior.admission,
		});
	}
	const expected = typeof command.expected_turn_id === "number" ? command.expected_turn_id : admission.turnEpoch;
	const result = admission.admit({
		delivery_id: clientMessageId ?? `tui-rpc-${randomUUID()}`,
		text: message,
		sender: { kind: "external", platform: "rpc" },
		deliverAs,
		expected_turn_id: expected,
		whenIdle: whenIdle === "start" ? "start" : "queue",
	});
	const identity = clientMessageId === undefined ? {} : { clientMessageId };
	const admitted = (disposition: "started" | "queued"): object => {
		if (clientMessageId === undefined) return answered(id, command.type, { disposition });
		const receipt: TerminalInputReceipt = {
			fingerprint,
			disposition,
			admission: { clientMessageId, durableSessionId: context.session.sessionId, disposition },
		};
		context.attachments.receipts.set(clientMessageId, receipt);
		return answered(id, command.type, { disposition, clientMessageId, admission: receipt.admission });
	};
	switch (result.kind) {
		case "started":
			return admitted("started");
		case "steered":
		case "queued":
			return admitted("queued");
		case "already_admitted":
			return answered(id, command.type, { disposition: "queued", duplicate: true, ...identity });
		case "held_draft":
			return refusal(id, command.type, "held_draft", {
				reason: "the user is composing in this terminal, so nothing was delivered",
				action: "retry after the draft is sent or cleared",
			});
		case "turn_conflict":
			return refusal(id, command.type, "turn_conflict", {
				reason: `the turn moved on (now ${result.turn_epoch}); this steer named an earlier one`,
				action: "read get_state's turn_epoch and send it again",
			});
	}
}

function answered(id: string | undefined, command: string, data: object): object {
	return { ...(id === undefined ? {} : { id }), type: "response", command, success: true, data };
}
