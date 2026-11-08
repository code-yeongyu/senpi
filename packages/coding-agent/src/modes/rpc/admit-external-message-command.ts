/**
 * `admit_external_message` (senpi#6233): the session's own `ExternalAdmission.admit`, the call behind
 * `pi.session.admitExternalMessage`. The engine writes its fixed `session_control_delivery` entry: never a user message,
 * never the extension `input` event, never a slash command or prompt template, whatever the text says.
 *
 * What the engine adds comes from the connection the record arrived on (`DeliveryPeer`), never from the record (the
 * security design gate's binding conditions): the device a remote connection speaks for is stamped into the entry and
 * ahead of the text the model reads, the ledger keys the delivery under that device, a `command_line` sender is refused
 * from a remote device, the turn that consumes the delivery takes the connection's origin, the thread-chain guard
 * runs first, and an id the transcript already holds is answered `already_admitted` after a restart too.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { writtenDeliveryIds } from "../../core/external-admission.ts";
import type { SessionControlSender } from "../../core/extensions/session-control-types.ts";
import type { ConnectionOrigin } from "../../core/turn-origin.ts";
import type { RpcAdmitExternalMessageCommand, RpcAdmitExternalMessageReply } from "./admit-external-message-wire.ts";
import { admitInputChain, type ChainRefusal } from "./chain-admission.ts";
import type { RpcRemoteOrigin } from "./remote-origin.ts";

/** The connection a delivery arrived on, as the host knows it. */
export interface DeliveryPeer {
	/** The remote device the connection speaks for (`ConnectionRoles.originOf`); absent on a plain local connection. */
	readonly origin: RpcRemoteOrigin | undefined;
	readonly connectionOrigin: ConnectionOrigin;
}

export type AdmitExternalMessageAnswer =
	| { readonly ok: true; readonly data: RpcAdmitExternalMessageReply }
	| { readonly ok: false; readonly refusal: ChainRefusal | { readonly message: string; readonly errorCode: string } };

type AdmittingSession = Pick<AgentSession, "externalAdmission" | "sessionManager" | "settingsManager">;

const SENDER_NOT_ALLOWED = "sender_not_allowed";
const CANONICAL_TURN_ID = /^(0|[1-9]\d{0,15})$/;

/** The ledger key: a remote device's ids live under that device, a local connection's under its own prefix. */
function ledgerId(deliveryId: string, origin: RpcRemoteOrigin | undefined): string {
	return origin === undefined
		? `rpc:local/${deliveryId}`
		: `device:${encodeURIComponent(origin.deviceId)}/${deliveryId}`;
}

function claimedSender(sender: SessionControlSender | undefined): string {
	if (sender === undefined) return "It names no sender.";
	const claim =
		sender.kind === "agent"
			? `agent ${JSON.stringify(sender.name ?? "")} in session ${sender.session_id}`
			: sender.kind === "external"
				? `${sender.platform}${sender.author === undefined ? "" : ` user ${JSON.stringify(sender.author)}`}`
				: "the command line";
	return `It says it was sent by ${claim}; that claim is not verified.`;
}

/** The line the engine writes ahead of a remote device's text, so the model reads provenance the caller cannot write. */
function provenanceLine(origin: RpcRemoteOrigin, sender: SessionControlSender | undefined): string {
	const device = origin.deviceName === undefined ? origin.deviceId : `${origin.deviceName} (${origin.deviceId})`;
	return `[Relayed message from remote device ${device}. ${claimedSender(sender)}]`;
}

export function admitExternalMessage(
	session: AdmittingSession,
	command: RpcAdmitExternalMessageCommand,
	peer: DeliveryPeer,
): AdmitExternalMessageAnswer {
	const chain = admitInputChain(command.chainCount, session.settingsManager);
	if (chain.kind === "refused") return { ok: false, refusal: chain.refusal };
	const { origin } = peer;
	if (origin !== undefined && command.sender?.kind === "command_line")
		return {
			ok: false,
			refusal: {
				message: `${SENDER_NOT_ALLOWED}: a remote device cannot send as this machine's command line`,
				errorCode: SENDER_NOT_ALLOWED,
			},
		};
	const admission = session.externalAdmission;
	const answer = (kind: RpcAdmitExternalMessageReply["kind"], epoch: number): AdmitExternalMessageAnswer => ({
		ok: true,
		data: { kind, turnId: String(epoch) },
	});
	const id = ledgerId(command.deliveryId, origin);
	if (session.sessionManager.reduceHistory(writtenDeliveryIds).has(id))
		return answer("already_admitted", admission.turnEpoch);
	const expected = command.expectedTurnId;
	if (expected !== undefined && !CANONICAL_TURN_ID.test(expected)) return answer("turn_conflict", admission.turnEpoch);
	const displayText = command.displayText ?? (origin === undefined ? undefined : command.text);
	const result = admission.admit(
		{
			delivery_id: id,
			text: origin === undefined ? command.text : `${provenanceLine(origin, command.sender)}\n\n${command.text}`,
			deliverAs: command.deliverAs,
			...(command.sender === undefined ? {} : { sender: command.sender }),
			...(displayText === undefined ? {} : { display_text: displayText }),
			...(expected === undefined ? {} : { expected_turn_id: Number(expected) }),
			...(command.whenIdle === undefined ? {} : { whenIdle: command.whenIdle }),
		},
		{
			...(origin === undefined ? {} : { remoteOrigin: origin }),
			...(chain.chainCount === undefined ? {} : { chainCount: chain.chainCount }),
			turnMark: command.deliverAs === "steer" ? "join" : peer.connectionOrigin,
		},
	);
	return answer(result.kind, result.turn_epoch);
}
