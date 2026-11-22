import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getMessageText, type HarnessOptions } from "../../suite/harness.ts";

/** Effects are recorded by the tool, independently of CK22's dispatch ledger. */
export function recoveryTool(beforeEffect?: () => Promise<void>) {
	const effects: string[] = [];
	const aborted: string[] = [];
	const tool: AgentTool = {
		name: "record",
		label: "Record",
		description: "Record a deterministic effect.",
		parameters: Type.Object({}),
		execute: async (id, _params, signal) => {
			if (signal?.aborted) {
				aborted.push(id);
				throw new Error("aborted before effect");
			}
			await beforeEffect?.();
			effects.push(id);
			return { content: [{ type: "text", text: "recorded" }], details: {} };
		},
	};
	return { tool, effects, aborted };
}

/** Observe the public extension hooks, including the real result transformation. */
export function recoveryHooks(trace: string[]): NonNullable<HarnessOptions["extensionFactories"]> {
	return [
		(pi) => {
			pi.on("tool_call", (event) => {
				trace.push(`call:${event.toolCallId}`);
			});
			pi.on("tool_result", (event) => {
				trace.push(`result:${event.toolCallId}`);
				return { content: [{ type: "text", text: "hooked result" }] };
			});
			pi.on("message_end", (event) => {
				if (event.message.role === "toolResult") trace.push(`end:${event.message.toolCallId}`);
				if (event.message.role === "user" && getMessageText(event.message) === "turn left") trace.push("steering");
			});
		},
	];
}
