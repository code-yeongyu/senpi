import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type ModelReasoningEffort } from "@openai/codex-sdk";
import { nativeAgentEnvironment } from "../native-agent-sdk/acp-boundary.ts";
import type { NativeAgentEvent, NativeAgentRequest } from "../native-agent-sdk/stream.ts";

function assertNever(event: never): never {
	throw new Error(`Unexpected Codex SDK event: ${JSON.stringify(event)}`);
}

function modelReasoningEffort(request: NativeAgentRequest): ModelReasoningEffort | undefined {
	switch (request.reasoning) {
		case undefined:
			return undefined;
		case "max":
			return "xhigh";
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return request.reasoning;
	}
}

function isolatedCodexHome(): string {
	const runtimeHome = mkdtempSync(join(tmpdir(), "senpi-codex-sdk-"));
	chmodSync(runtimeHome, 0o700);
	const configuredHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
	const sourceAuth = join(configuredHome, "auth.json");
	if (existsSync(sourceAuth)) {
		const destinationAuth = join(runtimeHome, "auth.json");
		copyFileSync(sourceAuth, destinationAuth);
		chmodSync(destinationAuth, 0o600);
	}
	mkdirSync(join(runtimeHome, "sessions"), { recursive: true, mode: 0o700 });
	return runtimeHome;
}

export async function* runCodexSdk(request: NativeAgentRequest): AsyncIterable<NativeAgentEvent> {
	const codexHome = isolatedCodexHome();
	try {
		const env = nativeAgentEnvironment(["CODEX_API_KEY", "OPENAI_API_KEY"]);
		env.CODEX_HOME = codexHome;
		const thread = new Codex({ env }).startThread({
			workingDirectory: request.cwd,
			model: request.model,
			modelReasoningEffort: modelReasoningEffort(request),
			sandboxMode: "workspace-write",
			approvalPolicy: "untrusted",
			networkAccessEnabled: false,
			webSearchMode: "disabled",
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
	} finally {
		rmSync(codexHome, { recursive: true, force: true });
	}
}
