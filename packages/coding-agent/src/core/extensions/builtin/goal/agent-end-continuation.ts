import type { AgentEndEvent, ExtensionContext } from "../../types.ts";
import type { MonitorAwareGoalContinuation } from "./monitor-continuation.ts";
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
	if (options.event.aborted === true && options.event.abortSource === "system") {
		return monitor.afterSystemAbort({
			ctx: options.ctx,
			event: options.event,
			goal: options.goal,
			messages: options.event.messages,
			willRetry: options.event.willRetry === true,
		});
	}
	return monitor.afterAgentEnd({ ctx: options.ctx, goal: options.goal, messages: options.event.messages });
}
