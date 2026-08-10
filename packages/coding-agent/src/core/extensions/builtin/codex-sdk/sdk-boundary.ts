import { Codex } from "@openai/codex-sdk";
import type { NativeAgentEvent, NativeAgentRequest } from "../native-agent-sdk/stream.ts";

function assertNever(event: never): never {
	throw new Error(`Unexpected Codex SDK event: ${JSON.stringify(event)}`);
}

export async function* runCodexSdk(request: NativeAgentRequest): AsyncIterable<NativeAgentEvent> {
	const thread = new Codex().startThread({
		workingDirectory: request.cwd,
		model: request.model,
		sandboxMode: "workspace-write",
		approvalPolicy: "never",
		skipGitRepoCheck: true,
	});
	const turn = await thread.runStreamed(request.prompt, { signal: request.signal });
	for await (const event of turn.events) {
		switch (event.type) {
			case "item.completed":
				if (event.item.type === "agent_message") yield { type: "text", text: event.item.text };
				break;
			case "turn.completed":
				yield {
					type: "usage",
					input: event.usage.input_tokens,
					output: event.usage.output_tokens,
					cacheRead: event.usage.cached_input_tokens,
					cacheWrite: event.usage.cache_write_input_tokens,
				};
				break;
			case "turn.failed":
				throw new Error(event.error.message);
			case "error":
				throw new Error(event.message);
			case "thread.started":
			case "turn.started":
			case "item.started":
			case "item.updated":
				break;
			default:
				assertNever(event);
		}
	}
}
