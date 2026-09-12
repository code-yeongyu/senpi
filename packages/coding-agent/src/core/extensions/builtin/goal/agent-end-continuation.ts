import type { AgentEndEvent, ExtensionContext } from "../../types.ts";
import { isMalformedToolUseTurn } from "./continuation.ts";
import type { MonitorAwareGoalContinuation } from "./monitor-continuation.ts";
import { updateGoal } from "./store.ts";
import { goalStoreRef } from "./store-ref.ts";
import { didTerminalPolicyRejectionEndTurn, didTerminalProviderErrorEndTurn } from "./terminal-provider-error.ts";
import type { Goal } from "./types.ts";

interface GoalAgentEndOptions {
	readonly ctx: ExtensionContext;
	readonly event: AgentEndEvent;
	readonly goal: Goal | null;
}

export async function continueGoalAfterAgentEnd(
	monitor: MonitorAwareGoalContinuation,
	options: GoalAgentEndOptions,
): Promise<Goal | null> {
	if (options.goal?.status === "active" && didTerminalPolicyRejectionEndTurn(options.event)) {
		const blocked = await updateGoal(goalStoreRef(options.ctx.sessionManager, options.ctx.cwd), {
			status: "blocked",
			reason: "provider policy rejection ended the turn",
		});
		// Cancel armed timers and staged recoveries; only an explicit goal resume
		// may restart a policy-blocked goal, not an infrastructure recovery path.
		monitor.syncGoal(blocked);
		return blocked;
	}
	if (options.event.aborted === true && options.event.abortSource === "system") {
		return monitor.afterSystemAbort({
			ctx: options.ctx,
			event: options.event,
			goal: options.goal,
			messages: options.event.messages,
			willRetry: options.event.willRetry === true,
		});
	}
	const lastAssistant = [...options.event.messages].reverse().find((message) => message.role === "assistant");
	if (lastAssistant?.role === "assistant" && isMalformedToolUseTurn(lastAssistant)) {
		return monitor.afterProviderFailure({
			ctx: options.ctx,
			event: options.event,
			goal: options.goal,
			messages: options.event.messages,
			willRetry: options.event.willRetry === true,
		});
	}
	if (didTerminalProviderErrorEndTurn(options.event)) {
		return monitor.afterProviderFailure({
			ctx: options.ctx,
			event: options.event,
			goal: options.goal,
			messages: options.event.messages,
			willRetry: options.event.willRetry === true,
		});
	}
	return monitor.afterAgentEnd({ ctx: options.ctx, goal: options.goal, messages: options.event.messages });
}
