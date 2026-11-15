/**
 * `hand_link` (R3, senpi#5924): one relayed packet batch of a hosted session's link to this machine's hand
 * (`hand-link-endpoint.ts`). Only a delegated connection sends it, and the sender every epoch check sees is that
 * connection's principal as the forwarder declared it: the record names the session and its loop, never who sent it.
 */
import type { DelegatedConnectionView } from "./connection-roles.ts";
import type { HandLinkEndpoint } from "./hand-link-endpoint.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { error } from "./session-router-errors.ts";

type HandLinkCommand = Extract<RpcCommand, { type: "hand_link" }>;

export interface HandLinkHost {
	readonly defaults: { readonly handLink?: HandLinkEndpoint };
	readonly writer: {
		currentConnection(): string | undefined;
		readonly delegations: { viewOf(id: string): DelegatedConnectionView | undefined };
	};
}

const isGeneration = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

function batchOf(command: HandLinkCommand) {
	const { session, loop, packets } = command;
	if (typeof session !== "string" || session.length === 0 || !Array.isArray(packets)) return undefined;
	if (typeof loop !== "object" || loop === null || typeof loop.id !== "string" || loop.id.length === 0)
		return undefined;
	if (!isGeneration(loop.generation)) return undefined;
	return { session, loop: { id: loop.id, generation: loop.generation }, packets };
}

export async function answerHandLink(host: HandLinkHost, command: HandLinkCommand): Promise<RpcResponse> {
	const endpoint = host.defaults.handLink;
	if (endpoint === undefined) return error(command.id, command.type, "hand_link_unsupported");
	const connection = host.writer.currentConnection();
	const view = connection === undefined ? undefined : host.writer.delegations.viewOf(connection);
	if (view === undefined || view.closed) return error(command.id, command.type, "hand_link_not_delegated");
	const batch = batchOf(command);
	if (batch === undefined) return error(command.id, command.type, "hand_link_malformed");
	let answer: Awaited<ReturnType<HandLinkEndpoint["link"]>>;
	try {
		answer = await endpoint.link(view.descriptor.principal.deviceId, batch);
	} catch (cause) {
		// The endpoint's durable state could not be opened or written: nothing of this batch reached the hand.
		return error(command.id, command.type, "hand_link_unavailable", {
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
	if (answer.kind === "refused") return error(command.id, command.type, answer.reason);
	const { packets, more } = answer;
	return { id: command.id, type: "response", command: "hand_link", success: true, data: { packets, more } };
}
