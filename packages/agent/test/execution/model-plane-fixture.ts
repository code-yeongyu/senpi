// Shared fixture for the S31 model-plane tests: a brain and a hand joined by the reference transport over an
// in-process carrier (split-local), a hand whose one tool is model-backed, and one tool call driven through the
// brain's remote ToolHost.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach } from "vitest";
import { PlaneRefusedError } from "../../src/execution/plane.ts";
import { createModelPlaneClient, type ModelPlaneRequest } from "../../src/execution/plane-model.ts";
import { createRemoteExecutor, type HandCall, type HandScope } from "../../src/execution/remote-executor.ts";
import type { createRemoteToolHost } from "../../src/execution/remote-tool-host.ts";
import type { ToolHostResult } from "../../src/execution/tool-host.ts";
import { createInProcessNetwork } from "../../src/transport/in-process-carrier.ts";
import { localEndpoint } from "../../src/transport/local-endpoint.ts";
import { createReliableTransport } from "../../src/transport/reliable-transport.ts";
import type { TransportSide } from "../../src/transport/transport.ts";
import type { AgentToolResult } from "../../src/types.ts";

export const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function side(): TransportSide {
	return createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => {
			throw error;
		},
	});
}

export function link(): { readonly brain: TransportSide; readonly hand: TransportSide } {
	const network = createInProcessNetwork();
	const endpoint = localEndpoint("linux", `plane-${crypto.randomUUID()}`, "/tmp");
	const brain = side();
	const hand = side();
	const stop = network.listen(endpoint, hand);
	const connection = network.dial(endpoint, brain);
	connection.connect();
	cleanups.push(() => {
		connection.drop();
		stop();
	});
	return { brain, hand };
}

export function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "brain-provider",
		model: "brain-model",
		timestamp: 1,
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

export function textOf(message: AssistantMessage): string {
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export function startHand(
	transport: TransportSide,
	request: (call: HandCall) => ModelPlaneRequest | Record<string, unknown>,
): void {
	const scope: HandScope = {
		async run(call) {
			try {
				const reply = await createModelPlaneClient(call.nested).complete(
					request(call) as ModelPlaneRequest,
					call.signal,
				);
				return { content: [{ type: "text", text: textOf(reply) }], details: {} } satisfies AgentToolResult<unknown>;
			} catch (error) {
				const reason = error instanceof PlaneRefusedError ? `refused:${error.reason}` : String(error);
				return { content: [{ type: "text", text: reason }], details: {}, isError: true };
			}
		},
		isSequential: () => false,
		dispose: async () => {},
	};
	const executor = createRemoteExecutor({
		transport,
		openScope: async () => scope,
		onFault: (error) => {
			throw error;
		},
	});
	cleanups.push(() => executor.close());
}

export function runCall(
	host: ReturnType<typeof createRemoteToolHost>,
	options: { readonly scopeId?: string; readonly signal?: AbortSignal } = {},
): Promise<ToolHostResult> {
	return host.execute(
		{
			scope: { id: options.scopeId ?? "scope-a", root: "/work" },
			calls: [{ type: "toolCall", id: "call-1", name: "summarize", arguments: {} }],
			mode: "parallel",
		},
		{ emit: () => {}, ...(options.signal ? { signal: options.signal } : {}) },
	);
}

export function resultText(result: ToolHostResult): string {
	return result.messages
		.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
		.join("|");
}

export const PROMPT: ModelPlaneRequest = {
	context: { systemPrompt: "be brief", messages: [{ role: "user", content: "summarize this", timestamp: 1 }] },
	options: { maxTokens: 64 },
};
