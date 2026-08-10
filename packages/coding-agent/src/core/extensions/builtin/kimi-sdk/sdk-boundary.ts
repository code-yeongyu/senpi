import { runAcpAgent } from "../native-agent-sdk/acp-boundary.ts";
import type { NativeAgentEvent, NativeAgentRequest } from "../native-agent-sdk/stream.ts";

export async function* runKimiSdk(request: NativeAgentRequest): AsyncIterable<NativeAgentEvent> {
	yield* runAcpAgent(request, "kimi", ["--model", request.model, "acp"], "senpi-kimi-sdk", [
		"KIMI_API_KEY",
		"MOONSHOT_API_KEY",
	]);
}
