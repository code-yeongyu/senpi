import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type {
	AuthGatewayProviderRuntime,
	AuthGatewayProviderRuntimeCall,
	AuthGatewayProviderRuntimeResult,
} from "../../src/core/auth-gateway-provider-runtime.ts";
import { createAuthGatewayResponsesPiAdapter } from "../../src/core/auth-gateway-responses-pi-adapter.ts";

describe("auth gateway Responses state", () => {
	it("issues opaque response capabilities", async () => {
		// Given: a completed Responses request stored for later chaining.
		const runtime = new StateRuntime([textStream("first")]);
		const adapter = createAuthGatewayResponsesPiAdapter({ runtime });

		// When: the adapter returns the public response identifier.
		const response = await adapter.responses({
			body: { input: "first prompt", model: "gateway-model", stream: false },
		});
		expect(response.kind).toBe("json");
		if (response.kind !== "json") throw new Error("Expected JSON response");
		const responseId = readResponseId(response.body);

		// Then: the identifier is an unguessable capability rather than a process sequence.
		expect(responseId).not.toMatch(/^resp_gateway_\d+$/);
		expect(responseId.length).toBeGreaterThanOrEqual(24);
	});

	it("evicts the oldest chained context at the configured bound", async () => {
		// Given: more completed Responses streams than the adapter may retain.
		const streams = Array.from({ length: 258 }, (_, index) => textStream(`response-${index}`));
		const runtime = new StateRuntime(streams);
		const adapter = createAuthGatewayResponsesPiAdapter({ runtime });
		const first = await adapter.responses({
			body: { input: "first prompt", model: "gateway-model", stream: false },
		});
		expect(first.kind).toBe("json");
		if (first.kind !== "json") throw new Error("Expected JSON response");
		const firstId = readResponseId(first.body);

		// When: later completions exceed the default retained-context bound.
		for (let index = 1; index <= 256; index++) {
			await adapter.responses({
				body: { input: `prompt-${index}`, model: "gateway-model", stream: false },
			});
		}
		const evicted = await adapter.responses({
			body: {
				input: "follow-up",
				model: "gateway-model",
				previous_response_id: firstId,
				stream: false,
			},
		});

		// Then: the oldest capability no longer exposes its retained conversation.
		expect(evicted).toEqual({
			body: { error: { message: "unknown previous response", type: "invalid_request_error" } },
			kind: "json",
			statusCode: 404,
		});
		expect(runtime.calls).toHaveLength(257);
	});
});

class StateRuntime implements AuthGatewayProviderRuntime {
	readonly calls: AuthGatewayProviderRuntimeCall[] = [];
	private readonly streams: AssistantMessageEventStream[];

	constructor(streams: AssistantMessageEventStream[]) {
		this.streams = streams;
	}

	async stream(call: AuthGatewayProviderRuntimeCall): Promise<AuthGatewayProviderRuntimeResult> {
		this.calls.push(call);
		const stream = this.streams.shift();
		if (stream === undefined) throw new Error("Fixture stream exhausted");
		return { kind: "stream", leaseId: "lease-state", model: model(), stream };
	}

	close(): void {}
}

function textStream(text: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const complete = message(text);
	stream.push({ partial: complete, type: "start" });
	stream.push({ message: complete, reason: "stop", type: "done" });
	stream.end();
	return stream;
}

function message(text: string): AssistantMessage {
	return {
		api: "gateway-faux",
		content: [{ text, type: "text" }],
		model: "gateway-model",
		provider: "gateway-provider",
		role: "assistant",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			cacheRead: 0,
			cacheWrite: 0,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
			input: 0,
			output: 0,
			totalTokens: 0,
		},
	};
}

function model(): Model<string> {
	return {
		api: "gateway-faux",
		baseUrl: "http://gateway.invalid/v1",
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		contextWindow: 1_000,
		id: "gateway-model",
		input: ["text"],
		maxTokens: 100,
		name: "Gateway model",
		provider: "gateway-provider",
		reasoning: false,
	};
}

function readResponseId(body: unknown): string {
	if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
		throw new Error("Expected Responses id");
	}
	return body.id;
}
