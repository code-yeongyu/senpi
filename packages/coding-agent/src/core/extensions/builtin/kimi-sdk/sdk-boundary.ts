import { type NativeAgentSessionConfigOption, runAcpAgent } from "../native-agent-sdk/acp-boundary.ts";
import type { NativeAgentEvent, NativeAgentRequest } from "../native-agent-sdk/stream.ts";

export function kimiSessionConfigOptions(request: NativeAgentRequest): readonly NativeAgentSessionConfigOption[] {
	let thinking: string | undefined;
	switch (request.reasoning) {
		case undefined:
			return [];
		case "minimal":
		case "low":
			thinking = "low";
			break;
		case "medium":
		case "high":
			thinking = "high";
			break;
		case "xhigh":
		case "max":
			thinking = "max";
			break;
	}
	return [{ configId: "thinking", value: thinking }];
}

export async function* runKimiSdk(request: NativeAgentRequest): AsyncIterable<NativeAgentEvent> {
	yield* runAcpAgent(
		request,
		"kimi",
		["--model", request.model, "acp"],
		"senpi-kimi-sdk",
		["KIMI_API_KEY", "MOONSHOT_API_KEY"],
		kimiSessionConfigOptions(request),
	);
}
