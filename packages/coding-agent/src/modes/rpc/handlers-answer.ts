import {
	answeredUiRequestId,
	type ExtensionUiResponseReply,
	refusedExtensionUiResponse,
	settleExtensionUiResponse,
} from "./extension-ui-response.ts";
import type { RpcExtensionUIResponse } from "./rpc-types.ts";
import type { SecretInputRequests } from "./secret-input-requests.ts";
import type { UiAnswerLedger } from "./ui-answer-ledger.ts";

type SettleTargets = Parameters<typeof settleExtensionUiResponse>[1];

export type AnswerTargets = {
	readonly secretInputs: Pick<SecretInputRequests, "has" | "respond">;
	readonly grantRequests: ReadonlyMap<string, string | undefined>;
	/** A worker's security bridge answers grant selections itself; this connection never checks them. */
	readonly workerSecurityBridge: boolean;
	/** The connection that sent the answer; undefined on a single-session stdio connection. */
	readonly sender: string | undefined;
	readonly grantCapable: () => boolean;
	readonly questions: SettleTargets["questions"];
	readonly dialogs: SettleTargets["dialogs"];
	readonly routed: boolean;
	readonly ledger: UiAnswerLedger;
	readonly beforeAnswer: () => void;
};

/**
 * The `answer`-class entry point: settles one `extension_ui_response` and returns its reply, or undefined when
 * a single-session stdio connection ignores an unnamed response that matches none of its requests. The first
 * answer to settle a request wins; a later one is refused (see `SessionExtensionUiRequests.resolve`).
 */
export function answerExtensionUiResponse(
	response: RpcExtensionUIResponse,
	targets: AnswerTargets,
): ExtensionUiResponseReply | undefined {
	// The grant rules apply to the request this response answers (`uiRequestId`, or `id` in the
	// short form), the same request `settleExtensionUiResponse` settles.
	const answered = answeredUiRequestId(response);
	if (
		(answered !== undefined && targets.secretInputs.has(answered)) ||
		("secret" in response && response.secret === true)
	)
		return targets.secretInputs.respond(response);
	if (!targets.workerSecurityBridge && answered !== undefined && targets.grantRequests.has(answered)) {
		// The sender hears the refusal, so its dialog does not vanish as if the answer had counted.
		if (targets.grantRequests.get(answered) !== targets.sender || !targets.grantCapable())
			return refusedExtensionUiResponse(response.id, "grant_answer_refused");
	}
	return settleExtensionUiResponse(response, {
		questions: targets.questions,
		dialogs: targets.dialogs,
		routed: targets.routed,
		ledger: targets.ledger,
		beforeAnswer: targets.beforeAnswer,
	});
}
