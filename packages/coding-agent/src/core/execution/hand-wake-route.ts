import { toStoreValue } from "@earendil-works/pi-agent-core";
import type { StoreValue } from "@earendil-works/pi-agent-core/conformance";
import type { LoopWakeRoute } from "../extensions/runner.ts";

/**
 * What a hand's late work did, as the loop's session does it: a custom message, a user message, a session entry
 * (`pi.appendEntry`, for example a Stop hook's stop state), or a UI notice.
 */
export type HandWakeSource = "message" | "user_message" | "entry" | "notice";

/** One late effect of a hand's work, for the hand's wake outbox; its scope is the runtime's own. */
export interface HandWake {
	readonly source: HandWakeSource;
	readonly payload: StoreValue;
}

/**
 * The loop-side effects of a hand runtime's late work (brain/hand split H3), each turned into a wake for the brain that
 * owns the scope: exactly the arguments a local session's `sendMessage`, `sendUserMessage`, `appendEntry` and
 * `ui.notify` would have received, plus the loop session's id when a loop-hook call on that session started the work.
 */
export function loopWakeRoute(offer: (wake: HandWake) => void, sessionId?: string): LoopWakeRoute {
	const wake = (source: HandWakeSource, fields: Record<string, unknown>): void =>
		offer({ source, payload: toStoreValue(sessionId === undefined ? fields : { ...fields, sessionId }) });
	return {
		sendMessage: (message, options) => wake("message", { message, options }),
		sendUserMessage: (content, options) => wake("user_message", { content, options }),
		appendEntry: (customType, data) => wake("entry", { customType, data }),
		notify: (message, type) => wake("notice", { message, type }),
	};
}

/**
 * Where a loop-hook call's effects go once the call ended: its runtime's wake outbox, or, on a runtime without one,
 * nowhere, and `dropped` reports each one so it is never lost silently. Its sends never throw: one whose value cannot
 * travel to the loop (a cycle, a BigInt) is reported to `dropped` too, so a flush of several goes on past it.
 */
export function lateLoopRoute(
	wake: ((wake: HandWake) => void) | undefined,
	dropped: (error: string) => void,
): (sessionId: string) => LoopWakeRoute {
	if (wake !== undefined)
		return (sessionId) => {
			const route = loopWakeRoute(wake, sessionId);
			const guarded = (what: string, send: () => void): void => {
				try {
					send();
				} catch (error) {
					dropped(
						`A ${what} from loop session ${sessionId}'s hook work could not travel to the loop and was dropped: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			};
			return {
				sendMessage: (message, options) => guarded("message", () => route.sendMessage(message, options)),
				sendUserMessage: (content, options) =>
					guarded("user message", () => route.sendUserMessage(content, options)),
				appendEntry: (customType, data) => guarded("session entry", () => route.appendEntry(customType, data)),
				notify: (message, type) => guarded("notice", () => route.notify(message, type)),
			};
		};
	return (sessionId) => {
		const drop = (what: string) =>
			dropped(
				`A ${what} from loop session ${sessionId}'s hook work arrived after its call ended and was dropped: this runtime has no wake route to the loop.`,
			);
		return {
			sendMessage: () => drop("message"),
			sendUserMessage: () => drop("user message"),
			appendEntry: () => drop("session entry"),
			notify: () => drop("notice"),
		};
	};
}
