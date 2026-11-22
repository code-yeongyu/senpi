import { DENIAL_IS_FINAL, type ReplyInput, type Request } from "../permission-system/types.ts";

/**
 * The `open_session.context` label an opener sets when no client of the session answers its prompts (a thread
 * another agent created, oh-my-openagent#14649). Such a session refuses what it would ask about, as a session with no UI does.
 */
export const REFUSE_APPROVALS_CONTEXT_KEY = "approvals";
export const REFUSE_APPROVALS_CONTEXT_VALUE = "refuse";
/**
 * The session entry a labelled session records on its first start: the session keeps refusing when a later open of its
 * file carries no label (a wake after its process died, a handover, a reopen by path).
 */
export const REFUSE_APPROVALS_ENTRY_TYPE = "permission-approvals-refused";

export interface NoUIOptions {
	readonly emitEvent: (event: string, data: unknown) => void;
	/** The `auto` preset is active. */
	readonly presetBound?: boolean;
	/** The session's opener declared that nobody answers its prompts (`REFUSE_APPROVALS_CONTEXT_KEY`). */
	readonly refusedByOpener?: boolean;
}

/**
 * Answers, with no UI to ask (print mode, unbound SDK, a session whose opener declared nobody answers), a request the
 * permission service is still asking about. The service has already applied every rule and found at least one pattern it
 * must ask about, so the answer is always a refusal with a reason, never an approval; a configured allow or deny for the
 * other patterns does not change that.
 */
export function handleNoUI(
	request: Request,
	{ emitEvent, presetBound = false, refusedByOpener = false }: NoUIOptions,
): ReplyInput {
	emitEvent("permission_asked", request);
	const patternsStr = request.patterns.join(", ");
	const required = `Permission required for ${request.permission} (${patternsStr})`;
	return {
		requestID: request.id,
		reply: "reject",
		message: refusedByOpener
			? `${required}, and nobody answers this session's prompts, so the call did not run. ${DENIAL_IS_FINAL} The session that opened this one chose its permission preset; it can open a session with a preset that allows the call.`
			: presetBound
				? `${required}, and there is no UI to ask, so the call did not run. ${DENIAL_IS_FINAL} Under the auto preset, allow rules do not widen what it approves; the user can run it interactively or choose another preset.`
				: `${required}, and there is no UI to ask, so the call did not run. ${DENIAL_IS_FINAL} The user can allow it with --permission ${request.permission}=allow.`,
	};
}
