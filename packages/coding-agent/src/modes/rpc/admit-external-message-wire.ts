/**
 * The wire of `admit_external_message` (senpi#6233): a message another agent sent this session, relayed over RPC and
 * admitted the way `pi.session.admitExternalMessage` admits it in process. The fields mirror
 * `AdmitExternalMessageInput` in the wire's camelCase, plus a thread call's `chainCount`; turn ids are strings, as
 * `get_state.currentTurnId`. The field checks run on the local connection and inside `validateRpcInboundRecord`, so
 * both paths refuse the same records.
 */
import type {
	ExternalAdmissionKind,
	ExternalDeliverAs,
	SessionControlSender,
} from "../../core/extensions/session-control-types.ts";

export interface RpcAdmitExternalMessageCommand {
	id?: string;
	type: "admit_external_message";
	/** The delivery's id: admitting an id this runtime already holds or wrote answers `already_admitted`. */
	deliveryId: string;
	/** What the model reads, provenance included. */
	text: string;
	/** Who the caller says sent it, for the surfaces a human reads; a claim, shown after the engine-stamped device. */
	sender?: SessionControlSender;
	/** The message as its sender wrote it, for human surfaces. */
	displayText?: string;
	deliverAs: ExternalDeliverAs;
	/** The turn the sender observed (`get_state.currentTurnId`); a steer is admitted only while it is current. */
	expectedTurnId?: string;
	/** What an idle session does with it: `start` (the default) starts a turn, `queue` holds it for the next one. */
	whenIdle?: "start" | "queue";
	/** A thread call's hop count (1 for a chain's first hop), checked against the user's chain limit first (K8). */
	chainCount?: number;
}

export interface RpcAdmitExternalMessageReply {
	kind: ExternalAdmissionKind;
	/** The session's turn when the delivery was admitted, in `get_state.currentTurnId`'s form. */
	turnId: string;
}

export interface RpcAdmitExternalMessageResponse {
	id?: string;
	type: "response";
	command: "admit_external_message";
	success: true;
	data: RpcAdmitExternalMessageReply;
}

/** The bound every id and label of the record stays inside, as the other local field checks bound theirs. */
const MAX_ID_CHARACTERS = 256;

const SENDER_FIELDS = {
	agent: { required: ["session_id"], optional: ["name"] },
	command_line: { required: [], optional: ["user"] },
	external: { required: ["platform"], optional: ["author"] },
} as const satisfies Record<
	SessionControlSender["kind"],
	{ readonly required: readonly string[]; readonly optional: readonly string[] }
>;

const SENDER_SHAPE =
	'sender must be { kind: "agent", session_id, name? }, { kind: "command_line", user? } or { kind: "external", platform, author? }, each value a non-empty string of at most 256 characters.';

function boundedId(value: unknown): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARACTERS;
}

/** A well-formed sender of a known kind with no other field, so nothing beyond the label can ride along. */
function isDeliverySender(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const kind: unknown = Reflect.get(value, "kind");
	if (typeof kind !== "string" || !Object.hasOwn(SENDER_FIELDS, kind)) return false;
	const { required, optional } = SENDER_FIELDS[kind as SessionControlSender["kind"]];
	const allowed = new Set<string>(["kind", ...required, ...optional]);
	return (
		Object.keys(value).every((key) => allowed.has(key)) &&
		required.every((key) => boundedId(Reflect.get(value, key))) &&
		optional.every((key) => Reflect.get(value, key) === undefined || boundedId(Reflect.get(value, key)))
	);
}

function fieldProblem(value: Record<string, unknown>, maxTextCharacters: number): string | undefined {
	if (!boundedId(value.deliveryId)) return "needs deliveryId, a non-empty string of at most 256 characters.";
	if (typeof value.text !== "string" || value.text.trim() === "" || value.text.length > maxTextCharacters)
		return `needs text, a non-empty string of at most ${maxTextCharacters} characters.`;
	if (value.deliverAs !== "steer" && value.deliverAs !== "followUp") return 'deliverAs must be "steer" or "followUp".';
	if (
		value.displayText !== undefined &&
		(typeof value.displayText !== "string" || value.displayText.length > maxTextCharacters)
	)
		return `displayText must be a string of at most ${maxTextCharacters} characters.`;
	if (value.expectedTurnId !== undefined && !boundedId(value.expectedTurnId))
		return "expectedTurnId must be a non-empty string of at most 256 characters; read it from get_state.currentTurnId.";
	if (value.chainCount !== undefined && !(Number.isSafeInteger(value.chainCount) && (value.chainCount as number) >= 1))
		return "chainCount must be a positive integer (1 for a chain's first hop).";
	// The device is stamped by the engine from the connection; a record that names one is refused, never copied.
	if (Object.hasOwn(value, "remote_origin") || Object.hasOwn(value, "remoteOrigin"))
		return "must not name remote_origin: the engine stamps the device the connection speaks for.";
	if (value.whenIdle !== undefined && value.whenIdle !== "start" && value.whenIdle !== "queue")
		return 'whenIdle must be "start" or "queue"; omit it to start a turn on an idle session.';
	if (value.sender !== undefined && !isDeliverySender(value.sender)) return SENDER_SHAPE;
	return undefined;
}

/** Why an `admit_external_message` record is refused, prefixed with its type; `undefined` for any other record. */
export function admitExternalMessageFieldError(
	value: Record<string, unknown>,
	maxTextCharacters: number,
): string | undefined {
	if (value.type !== "admit_external_message") return undefined;
	const problem = fieldProblem(value, maxTextCharacters);
	return problem === undefined ? undefined : `admit_external_message ${problem}`;
}
