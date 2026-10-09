/**
 * The terminal control endpoint's command surface. It answers who it is, which one session it holds
 * and that session's state and messages, renames it, streams its feed, wakes its inbox drain, relays
 * an answer to a question the session itself asked, and applies the pane's own session controls (a
 * model, a thinking level, an interrupt - `session-control-session-commands.ts`). Nothing here can
 * prompt, steer, queue a follow-up, open a session or run a command - one delivery authority (the
 * registrant's drain) applies messages, through admission, and only there. Every other command is
 * answered `unsupported` as data; `get_protocol_info` lists the accepted ones in `commands`.
 */
import { VERSION } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import type {
	AdmissionHoldReason,
	QuestionRequest,
	QuestionResponse,
	SessionControlDrainResult,
} from "../../core/extensions/types.ts";
import { answeredUiRequestId, settledQuestionStatus, unansweredQuestionIds } from "../rpc/extension-ui-response.ts";
import { buildRpcSessionState } from "../rpc/rpc-session-state.ts";
import type { ControlFeed } from "./session-control-feed.ts";
import { type ControlCommand, type ControlConnection, failure, success } from "./session-control-server.ts";
import {
	runSessionControlCommand,
	SESSION_CONTROL_COMMANDS,
	type TuiSessionControls,
} from "./session-control-session-commands.ts";

export interface TuiControlSurface extends TuiSessionControls {
	draftHold(): AdmissionHoldReason | undefined;
	blockingQuestion(): boolean;
	pendingQuestionIds(): readonly string[];
	pendingQuestion(requestId: string): Pick<QuestionRequest, "questions"> | undefined;
	answerQuestion(requestId: string, response: QuestionResponse): boolean;
	notice(line: string): void;
}

export interface ControlCommandContext {
	readonly instanceId: string;
	readonly session: AgentSession;
	readonly surface: TuiControlSurface;
	readonly feed: ControlFeed;
	readonly wake: (deliveryIds?: readonly string[]) => Promise<SessionControlDrainResult>;
}

export const TUI_CONTROL_CAPABILITY = "tui_control";

const TUI_CONTROL_COMMANDS = [
	"get_protocol_info",
	"list_sessions",
	"get_state",
	"get_messages",
	"set_session_name",
	"subscribe",
	"wake",
	"extension_ui_response",
	...SESSION_CONTROL_COMMANDS,
];

export async function runControlCommand(
	context: ControlCommandContext,
	connection: ControlConnection,
	command: ControlCommand,
): Promise<object> {
	const { id, type } = command;
	const { session } = context;
	switch (type) {
		case "get_protocol_info": {
			const build = engineBuildIdentity();
			return success(id, type, {
				protocolVersion: 1,
				serverVersion: VERSION,
				capabilities: [TUI_CONTROL_CAPABILITY],
				mode: "tui",
				instanceId: context.instanceId,
				generation: 0,
				engineVersion: build.text,
				engineOrdinal: build.ordinal,
				commands: TUI_CONTROL_COMMANDS,
			});
		}
		case "list_sessions":
			return success(id, type, { sessions: [sessionRow(session)] });
		case "get_state":
			return success(id, type, {
				...buildRpcSessionState(session),
				turn_epoch: session.externalAdmission.turnEpoch,
				blocking_question: context.surface.blockingQuestion(),
				compacting: session.isCompacting,
				editor_has_draft: context.surface.draftHold() !== undefined,
				state_version: context.feed.stateVersion,
			});
		case "get_messages":
			return success(id, type, { messages: session.messages });
		case "set_session_name": {
			const name = typeof command.name === "string" ? command.name.trim() : "";
			if (name === "") return failure(id, type, "Session name cannot be empty");
			session.setSessionName(name);
			return success(id, type);
		}
		case "subscribe": {
			const cursor = typeof command.cursor === "number" ? command.cursor : undefined;
			return success(id, type, { cursor: context.feed.subscribe(connection.id, cursor, connection.send) });
		}
		case "wake": {
			const ids = Array.isArray(command.delivery_ids)
				? command.delivery_ids.filter((entry): entry is string => typeof entry === "string")
				: undefined;
			const result = await context.wake(ids);
			return success(id, type, { admitted: result.admitted ?? [] });
		}
		case "extension_ui_response":
			return answerQuestion(context.surface, command);
		default:
			return (await runSessionControlCommand(session, context.surface, command)) ?? failure(id, type, "unsupported");
	}
}

function sessionRow(session: AgentSession): Readonly<Record<string, unknown>> {
	const manager = session.sessionManager;
	const created = manager.getHeader()?.timestamp ?? null;
	const last = manager.getEntries().at(-1);
	return {
		sessionId: session.sessionId,
		sessionPath: session.sessionFile ?? null,
		session_file: session.sessionFile ?? null,
		kind: "interactive",
		surface: "tui",
		cwd: manager.getCwd(),
		name: session.sessionName ?? null,
		created_at: created,
		updated_at: last?.timestamp ?? created,
		attachments: 1,
	};
}

/**
 * Only a question this session asked, and is still waiting on, can be answered. `uiRequestId` names
 * it (the short form: `id`); the reply always carries the frame's `id`, as on a host. The answer
 * settles by the host's rule (`settledQuestionStatus`), so the same frame reaches the model as the same
 * message on either surface.
 */
function answerQuestion(surface: TuiControlSurface, command: ControlCommand): object {
	const frameId = command.id;
	const requestId = answeredUiRequestId(command);
	const request = requestId === undefined ? undefined : surface.pendingQuestion(requestId);
	if (requestId === undefined || request === undefined) {
		return failure(frameId, "extension_ui_response", "unknown_request");
	}
	const response = questionResponse(command, request.questions);
	if (response === "question_incomplete") return failure(frameId, "extension_ui_response", response);
	if (response === undefined || !surface.answerQuestion(requestId, response)) {
		return failure(frameId, "extension_ui_response", "invalid_response");
	}
	return success(frameId, "extension_ui_response");
}

function questionResponse(
	command: ControlCommand,
	questions: QuestionRequest["questions"],
): QuestionResponse | "question_incomplete" | undefined {
	if (command.cancelled === true) return { status: "cancelled", answers: {}, unanswered: [] };
	const answers = command.answers;
	if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return undefined;
	const parsed: QuestionResponse["answers"] = {};
	for (const [question, value] of Object.entries(answers)) {
		if (typeof value !== "object" || value === null || !("selected" in value) || !Array.isArray(value.selected)) {
			return undefined;
		}
		const selected = value.selected.filter((entry: unknown): entry is string => typeof entry === "string");
		const text = "text" in value && typeof value.text === "string" ? value.text : undefined;
		parsed[question] = text === undefined ? { selected } : { selected, text };
	}
	const comment = typeof command.comment === "string" ? command.comment : undefined;
	const status = settledQuestionStatus(parsed, comment);
	if (status === undefined) return "question_incomplete";
	const unanswered = unansweredQuestionIds(questions, parsed);
	return {
		status,
		resolvedBy: "control_endpoint",
		answers: parsed,
		unanswered,
		...(comment === undefined ? {} : { comment }),
	};
}
