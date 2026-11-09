/**
 * The host commands a terminal control endpoint serves for its own session (senpi#3229): `open_session`
 * attaches by path or id, `subscribe_sessions`/`unsubscribe_sessions` run the host's status stream over
 * this one session, `steer`/`follow_up`/`prompt` go through the session's external admission (the
 * terminal's one delivery authority, so the user's draft still holds them) with the host's `whenIdle`
 * meaning, and `get_effect_status` reads the same effect ledger. The rest of the host's drive set answers with the
 * host's contract (senpi#4267): `set_client_info` declares the connection's roles, `attach_session` and
 * `release_attachment` take and drop a live attachment on the session's identity, `abort` runs the host's effect
 * path and its role rule (a Stop needs `interactive_user`), and input goes through `session-control-input-commands.ts`.
 * The private MCP form frames reach the terminal's presenters (D11 S3-6b). A frame this file does not own answers
 * `undefined` and falls through to the endpoint's other commands.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import { admitExternalMessageFieldError } from "../rpc/admit-external-message-wire.ts";
import { INTERACTIVE_USER_CAPABILITY } from "../rpc/custom-capability.ts";
import { runAbort, runGetEffectStatus } from "../rpc/effect-commands.ts";
import { buildRpcSessionState } from "../rpc/rpc-session-state.ts";
import { getSnapshot } from "../rpc/get-snapshot.ts";
import { MAX_RPC_MESSAGE_CHARACTERS } from "../rpc/rpc-input-validation.ts";
import type { RpcCommand } from "../rpc/rpc-types.ts";
import { answerSubscribeSessions, answerUnsubscribeSessions, refusal } from "../rpc/session-status-commands.ts";
import { type ControlAttachments, keyOf } from "./session-control-attach.ts";
import { admitInput, admitPrompt, answered, idOf } from "./session-control-input-commands.ts";
import { admitTerminalDelivery, setClientInfo } from "./session-control-peer-commands.ts";
import { type ControlCommand, type ControlConnection, failure, success } from "./session-control-server.ts";
import { TERMINAL_PRESENTER_COMMANDS } from "./terminal-presenter-surface.ts";

type Command<T extends RpcCommand["type"]> = Extract<RpcCommand, { type: T }>;

export const TUI_RPC_COMMANDS = [
	"open_session",
	"get_snapshot",
	"subscribe_sessions",
	"unsubscribe_sessions",
	"steer",
	"follow_up",
	"prompt",
	"admit_external_message",
	"get_effect_status",
	"set_client_info",
	"attach_session",
	"release_attachment",
	"abort",
	...TERMINAL_PRESENTER_COMMANDS,
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
		case "admit_external_message": {
			const fieldError = admitExternalMessageFieldError(command, MAX_RPC_MESSAGE_CHARACTERS);
			if (fieldError !== undefined) return failure(idOf(command), command.type, fieldError);
			return admitTerminalDelivery(
				context.session,
				context.attachments,
				connection,
				frame<"admit_external_message">(command),
			);
		}
		case "set_client_info":
			return setClientInfo(context.attachments, connection, command);
		case "attach_session":
			return attachSession(context, connection, command);
		case "release_attachment":
			return releaseAttachment(context, connection, command);
		case "abort":
			return abort(context, connection, frame<"abort">(command));
		case "mcp_presenter_context":
		case "mcp_form_presented":
		case "mcp_form_response":
		case "mcp_form_sync":
		case "mcp_presenter_secret_answer":
			if (!context.attachments.presenters) return undefined;
			context.attachments.presenters.receive(keyOf(connection), command);
			return null;
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
	if (command.takeover === true)
		return refusal(id, "attach_session", "takeover_unsupported", {
			reason: "only a headless engine with a takeover ledger takes sessions over",
			action: "attach without takeover",
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
