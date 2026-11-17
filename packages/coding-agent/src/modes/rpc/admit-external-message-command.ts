/**
 * `admit_external_message` (senpi#6233): the session's own `ExternalAdmission.admit`, the call behind
 * `pi.session.admitExternalMessage`. The engine writes its fixed `session_control_delivery` entry: never a user message,
 * never the extension `input` event, never a slash command or prompt template, whatever the text says.
 *
 * What the engine adds comes from the connection the record arrived on (`DeliveryPeer`), never from the record (the
 * security design gate's binding conditions): the device a remote connection speaks for is stamped into the entry's
 * metadata (`details.remote_origin`) while the model reads exactly the text a same-machine delivery carries (senpi#6250:
 * an agent need not know a message crossed devices), the ledger keys the delivery under that device, a `command_line` sender is refused
 * from a remote device, the turn that consumes the delivery takes the connection's origin, the thread-chain guard
 * runs first, and an id the transcript already holds is answered `already_admitted` after a restart too.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { writtenDeliveryIds } from "../../core/external-admission.ts";
import type { ConnectionOrigin, InputTurnMark } from "../../core/turn-origin.ts";
import type { RpcAdmitExternalMessageCommand, RpcAdmitExternalMessageReply } from "./admit-external-message-wire.ts";
import { admitInputChain, type ChainRefusal } from "./chain-admission.ts";
import type { RpcRemoteOrigin } from "./remote-origin.ts";

/** The connection a delivery arrived on, as the host knows it. */
export interface DeliveryPeer {
	/** The remote device the connection speaks for (`ConnectionRoles.originOf`); absent on a plain local connection. */
	readonly origin: RpcRemoteOrigin | undefined;
	readonly connectionOrigin: ConnectionOrigin;
	/** The origin the turn this delivery opens counts as (senpi#6342); the connection's origin when absent. */
	readonly turnOrigin?: ConnectionOrigin;
}

export type AdmitExternalMessageAnswer =
	| { readonly ok: true; readonly data: RpcAdmitExternalMessageReply }
	| { readonly ok: false; readonly refusal: ChainRefusal | { readonly message: string; readonly errorCode: string } };

type AdmittingSession = Pick<AgentSession, "externalAdmission" | "sessionManager" | "settingsManager">;

const SENDER_NOT_ALLOWED = "sender_not_allowed";
const DELEGATED_ORIGIN_UNKNOWN = "delegated_origin_unknown";
const CANONICAL_TURN_ID = /^(0|[1-9]\d{0,15})$/;

/** The ledger key: a remote device's ids live under that device, a local connection's under its own prefix. */
function ledgerId(deliveryId: string, origin: RpcRemoteOrigin | undefined): string {
	return origin === undefined
		? `rpc:local/${deliveryId}`
		: `device:${encodeURIComponent(origin.deviceId)}/${deliveryId}`;
}

/** The turn a delivery opens: a steer joins the running turn; anything else counts as the connection's turn origin. */
function deliveryTurnMark(command: RpcAdmitExternalMessageCommand, peer: DeliveryPeer): InputTurnMark {
	return command.deliverAs === "steer" ? "join" : (peer.turnOrigin ?? peer.connectionOrigin);
}

export function admitExternalMessage(
	session: AdmittingSession,
	command: RpcAdmitExternalMessageCommand,
	peer: DeliveryPeer,
): AdmitExternalMessageAnswer {
	const chain = admitInputChain(command.chainCount, session.settingsManager);
	if (chain.kind === "refused") return { ok: false, refusal: chain.refusal };
	const { origin } = peer;
	// A delegated connection that names no device is never treated as this machine's own: it is refused (fail closed).
	if (peer.connectionOrigin === "delegated" && origin === undefined)
		return {
			ok: false,
			refusal: {
				message: `${DELEGATED_ORIGIN_UNKNOWN}: a delegated connection that names no remote device cannot admit a delivery`,
				errorCode: DELEGATED_ORIGIN_UNKNOWN,
			},
		};
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
			text: command.text,
			deliverAs: command.deliverAs,
			...(command.sender === undefined ? {} : { sender: command.sender }),
			...(displayText === undefined ? {} : { display_text: displayText }),
			...(expected === undefined ? {} : { expected_turn_id: Number(expected) }),
			...(command.whenIdle === undefined ? {} : { whenIdle: command.whenIdle }),
		},
		{
			...(origin === undefined ? {} : { remoteOrigin: origin }),
			...(chain.chainCount === undefined ? {} : { chainCount: chain.chainCount }),
			turnMark: deliveryTurnMark(command, peer),
		},
	);
	return answer(result.kind, result.turn_epoch);
}
