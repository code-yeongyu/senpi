import type { ExtensionAPI, ExtensionContext } from "../../types.ts";

/** Own only the current branch's in-flight handoff, never a persisted request. */
export function createReductionHandoff(pi: ExtensionAPI, customInstructions: string) {
	let active: { sessionId: string; leaf: string | null } | undefined;
	return {
		isPending: () => active !== undefined,
		reset: () => {
			active = undefined;
		},
		request: (ctx: ExtensionContext) => {
			if (active) {
				ctx.abort("system");
				return;
			}
			const request = { sessionId: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId() };
			active = request;
			ctx.compact({
				customInstructions,
				onError: () => {
					if (active === request) active = undefined;
				},
				onComplete: () => {
					if (active !== request) return;
					active = undefined;
					if (
						ctx.sessionManager.getSessionId() !== request.sessionId ||
						(request.leaf && !ctx.sessionManager.getBranch().some((entry) => entry.id === request.leaf)) ||
						ctx.hasPendingMessages()
					)
						return;
					pi.sendMessage(
						{
							customType: "senpi.context-reduction.resume",
							content: "Continue the current task using the compacted context.",
							display: false,
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				},
			});
		},
	};
}
