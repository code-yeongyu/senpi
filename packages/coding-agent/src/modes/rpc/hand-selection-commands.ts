import type { HandSelection, HandSession } from "../headless/hand-selection.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { RPC_ERROR_UNKNOWN_SESSION } from "./rpc-types.ts";
import { code, detail, error } from "./session-router-errors.ts";

/** `list_hands` / `select_hand` (R4): answered only by a headless engine built with a hand directory. */
const UNSUPPORTED = "hand_selection_unsupported";

/** A command's session: the hand-facing half plus the durable id that `hand_selection` entries are keyed by. */
type CommandSession = HandSession & { readonly sessionId: string };

/** The only parts of the router context these two commands read, so a test can hand them a registry that is closing one. */
type HandSelectionHost = {
	readonly registry: {
		peek(handle: string): { readonly runtime?: { readonly session?: CommandSession } } | undefined;
		getForCommand(handle: string, command: string): { readonly runtime?: { readonly session?: CommandSession } };
	};
	readonly defaults: { readonly handSelection?: HandSelection };
};

function sessionOf(host: HandSelectionHost, sessionId: string) {
	return host.registry.peek(sessionId)?.runtime?.session;
}

export function answerListHands(
	host: HandSelectionHost,
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
	host: HandSelectionHost,
	command: Extract<RpcCommand, { type: "select_hand" }>,
): RpcResponse {
	const selection = host.defaults.handSelection;
	if (selection === undefined) return error(command.id, command.type, UNSUPPORTED);
	// A select is new work, so it goes through the command gate every other session command uses: peek also
	// hands back an entry the registry is already closing, and a select that landed in that window installed
	// a hand link on an ended session that nothing was left to close (senpi#5949 review).
	let session: CommandSession | undefined;
	try {
		session = host.registry.getForCommand(command.sessionId, command.type).runtime?.session;
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause));
	}
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
