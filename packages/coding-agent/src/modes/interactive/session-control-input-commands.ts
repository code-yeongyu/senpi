/**
 * Input a terminal control endpoint admits for its session (senpi#3229, senpi#4267): `steer`/`follow_up`/`prompt` go
 * through the session's external admission with the host's `whenIdle` meaning, and input sent with a
 * `clientMessageId` is answered with an admission receipt that a retry gets again, marked `replayed`.
 */
import { randomUUID } from "node:crypto";
import type { ExternalDeliverAs } from "../../core/extensions/session-control-types.ts";
import { refusal } from "../rpc/session-status-commands.ts";
import type { TerminalInputReceipt } from "./session-control-attach.ts";
import type { RpcCommandContext } from "./session-control-rpc-commands.ts";
import type { ControlCommand } from "./session-control-server.ts";

export function idOf(command: ControlCommand): string | undefined {
	return typeof command.id === "string" ? command.id : undefined;
}

export function answered(id: string | undefined, command: string, data: object): object {
	return { ...(id === undefined ? {} : { id }), type: "response", command, success: true, data };
}

export function admitPrompt(context: RpcCommandContext, command: ControlCommand): object {
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
	// A thread call's hop count cannot travel through text-only admission, so its chain would restart here (K8).
	"chainCount",
	// Admission queues the text and starts the turn later, at a leaf an admission-time check never sees (senpi#6922).
	"expectedLeafId",
] as const;

export function admitInput(
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
	const admitted = (disposition: TerminalInputReceipt["disposition"]): object => {
		const holds = {
			...(result.holds === undefined ? {} : { holds: [...result.holds] }),
			...(result.engine_turn_cap === undefined ? {} : { engineTurnCap: result.engine_turn_cap }),
		};
		if (clientMessageId === undefined) return answered(id, command.type, { disposition, ...holds });
		const receipt: TerminalInputReceipt = {
			fingerprint,
			disposition,
			admission: { clientMessageId, durableSessionId: context.session.sessionId, disposition },
		};
		context.attachments.receipts.set(clientMessageId, receipt);
		return answered(id, command.type, { disposition, clientMessageId, admission: receipt.admission, ...holds });
	};
	switch (result.kind) {
		case "started":
			return admitted("started");
		case "held":
			return admitted("held");
		case "steered":
		case "queued":
			return admitted("queued");
		case "already_admitted":
			return answered(id, command.type, { disposition: "queued", duplicate: true, ...identity });
		case "held_draft":
			return refusal(id, command.type, "held_draft", {
				reason:
					"input the user submitted in this terminal has not reached the runtime yet, so nothing was delivered",
				action: "retry once that input was taken",
			});
		case "turn_conflict":
			return refusal(id, command.type, "turn_conflict", {
				reason: `the turn moved on (now ${result.turn_epoch}); this steer named an earlier one`,
				action: "read get_state's turn_epoch and send it again",
			});
	}
}
