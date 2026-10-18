/**
 * Continue a session from its current leaf with no new prompt (senpi #1930).
 *
 * A request may not end with an assistant message on the default models
 * (Claude 4.6+ rejects assistant prefill, OpenAI's Responses API has none), so
 * the continuation is a hidden custom message (display false) that drives the
 * next turn, the same mechanism as the "." manual-continue shortcut. It has its
 * own type so extensions that react to a manual continue (a blocked goal
 * resuming) do not mistake it for one.
 */

export const CONTINUE_FROM_LEAF_CUSTOM_TYPE = "continue-from-leaf";

export const CONTINUE_FROM_LEAF_DIRECTIVE = `<system-notice>
Continue from where the conversation ends.

Your last reply may have been edited by the user; treat its current text as your own words.
Carry on from it without repeating it, apologizing for it, or commenting on the edit.
</system-notice>`;

export type ContinueFromLeafCode = "streaming" | "nothing_to_continue" | "leaf_not_assistant";

const CONTINUE_FROM_LEAF_MESSAGES: Record<ContinueFromLeafCode, string> = {
	streaming: "Wait for the current response to finish before continuing.",
	nothing_to_continue: "There is nothing to continue: the session has no messages yet.",
	leaf_not_assistant:
		"There is no answer to continue: the conversation ends on a user message. Send it, or retry it, instead.",
};

export class ContinueFromLeafError extends Error {
	readonly code: ContinueFromLeafCode;

	constructor(code: ContinueFromLeafCode) {
		super(CONTINUE_FROM_LEAF_MESSAGES[code]);
		this.name = "ContinueFromLeafError";
		this.code = code;
	}
}

export type TurnAdmissionDisposition = "started" | "delegated" | "finished-without-start";

export type TurnAdmissionEvent = { readonly type: "agent_start" };

/**
 * Resolves once the runtime took a continuation: its turn started (`agent_start`
 * plus the `started` disposition), or it was queued into a running turn
 * (`delegated`). The `agent_start` event and the disposition can arrive in EITHER
 * order (the disposition fires in a microtask, so an agent_start emitted in the
 * same tick would otherwise be missed). Tracking both and resolving on the pair
 * makes the wait order-independent - the single-flag form, resolving only when
 * `agent_start` lands AFTER the disposition callback, falls back to a turn-end
 * answer on that same-tick inversion (senpi #2708).
 */
export function trackTurnAdmission(input: {
	readonly disposition: Promise<TurnAdmissionDisposition>;
	readonly subscribe: (listener: (event: TurnAdmissionEvent) => void) => () => void;
}): { readonly promise: Promise<void>; readonly dispose: () => void } {
	let resolveStarted: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	let agentStartSeen = false;
	let startDispositionSeen = false;
	const maybeStarted = (): void => {
		if (agentStartSeen && startDispositionSeen) resolveStarted?.();
	};
	void input.disposition.then((disposition) => {
		if (disposition === "delegated") {
			resolveStarted?.();
			return;
		}
		if (disposition === "started") {
			startDispositionSeen = true;
			maybeStarted();
		}
	});
	const unsubscribe = input.subscribe((event) => {
		if (event.type === "agent_start") {
			agentStartSeen = true;
			maybeStarted();
		}
	});
	return { promise, dispose: unsubscribe };
}
