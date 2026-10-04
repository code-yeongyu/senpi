import type { ReplyInput, Request } from "../permission-system/types.ts";

export interface NoUIOptions {
	readonly emitEvent: (event: string, data: unknown) => void;
	/** The `auto` preset is active. */
	readonly presetBound?: boolean;
}

/**
 * Answers, with no UI to ask (print mode, unbound SDK), a request the permission service is still
 * asking about. The service has already applied every rule and found at least one pattern it must
 * ask about, so the answer is always a refusal with a reason, never an approval; a configured allow
 * or deny for the other patterns does not change that.
 */
export function handleNoUI(request: Request, { emitEvent, presetBound = false }: NoUIOptions): ReplyInput {
	emitEvent("permission_asked", request);
	const patternsStr = request.patterns.join(", ");
	return {
		requestID: request.id,
		reply: "reject",
		message: presetBound
			? `Permission required for ${request.permission} (${patternsStr}), and there is no UI to ask. Under the auto preset, allow rules do not widen what it approves; run it interactively or choose another preset.`
			: `Permission required for ${request.permission} (${patternsStr}). Use --permission ${request.permission}=allow to override.`,
	};
}
