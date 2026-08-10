import { runAcpAgent } from "../native-agent-sdk/acp-boundary.ts";
import type { NativeAgentEvent, NativeAgentRequest } from "../native-agent-sdk/stream.ts";

export async function* runGrokSdk(request: NativeAgentRequest): AsyncIterable<NativeAgentEvent> {
	yield* runAcpAgent(request, "grok", ["agent", "--model", request.model, "stdio"], "senpi-grok-sdk", ["XAI_API_KEY"]);
}
