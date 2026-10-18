/**
 * The host commands a terminal control endpoint serves for its own session (senpi#3229): `open_session`
 * attaches by path or id, `subscribe_sessions`/`unsubscribe_sessions` run the host's status stream over
 * this one session, `steer`/`follow_up`/`prompt` go through the session's external admission (the
 * terminal's one delivery authority, so the user's draft still holds them) with the host's `whenIdle`
 * meaning, and `get_effect_status` reads the same effect ledger. A frame this file does not own answers
 * `undefined` and falls through to the endpoint's other commands.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ExternalDeliverAs } from "../../core/extensions/session-control-types.ts";
import { runGetEffectStatus } from "../rpc/effect-commands.ts";
import { buildRpcSessionState } from "../rpc/rpc-session-state.ts";
import type { RpcCommand } from "../rpc/rpc-types.ts";
import { answerSubscribeSessions, answerUnsubscribeSessions, refusal } from "../rpc/session-status-commands.ts";
import { type ControlAttachments, keyOf } from "./session-control-attach.ts";
import type { ControlCommand, ControlConnection } from "./session-control-server.ts";

type Command<T extends RpcCommand["type"]> = Extract<RpcCommand, { type: T }>;

export const TUI_RPC_COMMANDS = [
	"open_session",
	"subscribe_sessions",
	"unsubscribe_sessions",
	"steer",
	"follow_up",
	"prompt",
	"get_effect_status",
] as const;

export interface RpcCommandContext {
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
	switch (result.kind) {
		case "started":
			return answered(id, command.type, { disposition: "started", ...identity });
		case "steered":
		case "queued":
			return answered(id, command.type, { disposition: "queued", ...identity });
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
