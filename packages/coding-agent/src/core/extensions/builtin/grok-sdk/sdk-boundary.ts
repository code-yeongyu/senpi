import { runAcpAgent } from "../native-agent-sdk/acp-boundary.ts";
import type { NativeAgentEvent, NativeAgentRequest } from "../native-agent-sdk/stream.ts";

function reasoningEffort(request: NativeAgentRequest): string | undefined {
	switch (request.reasoning) {
		case undefined:
			return undefined;
		case "minimal":
			return "low";
		case "low":
		case "medium":
		case "high":
			return request.reasoning;
		case "xhigh":
		case "max":
			return "high";
	}
}

export async function* runGrokSdk(request: NativeAgentRequest): AsyncIterable<NativeAgentEvent> {
	const effort = reasoningEffort(request);
	const args = ["agent", "--model", request.model];
	if (effort !== undefined) args.push("--reasoning-effort", effort);
	args.push("stdio");
	yield* runAcpAgent(request, "grok", args, "senpi-grok-sdk", ["XAI_API_KEY"]);
}
