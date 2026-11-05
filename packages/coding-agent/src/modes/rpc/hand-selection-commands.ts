import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { RPC_ERROR_UNKNOWN_SESSION } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

/** `list_hands` / `select_hand` (R4): answered only by a headless engine built with a hand directory. */
const UNSUPPORTED = "hand_selection_unsupported";

function sessionOf(host: RouterContext, sessionId: string) {
	return host.registry.peek(sessionId)?.runtime?.session;
}

export function answerListHands(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "list_hands" }>,
): RpcResponse {
	const selection = host.defaults.handSelection;
	if (selection === undefined) return error(command.id, command.type, UNSUPPORTED);
	const hands = selection
		.hands()
		.map(({ device, label, platform, reachable }) => ({ device, label, platform, reachable }));
	if (command.sessionId === undefined)
		return { id: command.id, type: "response", command: "list_hands", success: true, data: { hands } };
	const session = sessionOf(host, command.sessionId);
	if (session === undefined) return error(command.id, command.type, RPC_ERROR_UNKNOWN_SESSION);
	return {
		id: command.id,
		type: "response",
		command: "list_hands",
		success: true,
		data: { hands, selected: selection.selected(session.sessionId) },
	};
}

export function answerSelectHand(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "select_hand" }>,
): RpcResponse {
	const selection = host.defaults.handSelection;
	if (selection === undefined) return error(command.id, command.type, UNSUPPORTED);
	const session = sessionOf(host, command.sessionId);
	if (session === undefined) return error(command.id, command.type, RPC_ERROR_UNKNOWN_SESSION);
	const outcome = selection.select(session.sessionId, session, command.device);
	if (!outcome.ok) return error(command.id, command.type, outcome.refusal, { device: command.device });
	return {
		id: command.id,
		type: "response",
		command: "select_hand",
		success: true,
		data: { sessionId: command.sessionId, selected: command.device },
	};
}
