import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { opencodeGoProvider } from "../../../../ai/src/providers/opencode-go.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const model = harness.getModel();
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("issue #3406 OpenCode Go compaction session ID", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("forwards the authentic session ID to summarizationStream for x-opencode-session", async () => {
		const catalogModel: Model<"openai-completions"> = {
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: OPENCODE_GO_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		};

		let capturedSessionId: string | undefined;

		const respond = (requestModel: Model<any>) => {
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage("<summary>compact summary</summary>"),
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
				},
			});
			return stream;
		};

		const provider: Provider<"openai-completions"> = {
			id: "opencode-go",
			name: "OpenCode Go",
			baseUrl: OPENCODE_GO_BASE_URL,
			auth: {
				apiKey: {
					name: "OpenCode Go token",
					resolve: async () => ({ auth: { apiKey: "test-key" }, source: "explicit token" }),
				},
			},
			getModels: () => [catalogModel],
			stream: (requestModel, _context, options) => {
				capturedSessionId = (options as Record<string, unknown> | undefined)?.sessionId as string | undefined;
				return respond(requestModel);
			},
			streamSimple: (requestModel, _context, options) => {
				capturedSessionId = (options as Record<string, unknown> | undefined)?.sessionId as string | undefined;
				return respond(requestModel);
			},
		};

		harness = await createHarness({
			extensionFactories: [compactionExtension],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		});
		seedCompactableSession(harness);
		harness.session.agent.state.model = catalogModel;

		await harness.authStorage.modify("opencode-go", async () => ({
			type: "api_key",
			key: "test-key",
		}));

		const modelRuntime = harness.session.modelRuntime;
		modelRuntime.registerNativeProvider(provider);
		await modelRuntime.refresh({ allowNetwork: false, providers: ["opencode-go"] });

		await harness.session.compact();

		expect(capturedSessionId).toBe(harness.session.sessionId);
	});

	it("sends the active session ID on the real OpenCode Go compaction request", async () => {
		const received: Array<string | string[] | undefined> = [];
		const server = createServer((request, response) => {
			received.push(request.headers["x-opencode-session"]);
			request.resume();
			request.on("end", () => {
				const chunk = (delta: Record<string, unknown>, finish: string | null) =>
					`data: ${JSON.stringify({
						id: "chatcmpl-compaction",
						object: "chat.completion.chunk",
						created: 0,
						model: "test-model",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(chunk({ role: "assistant", content: "<summary>compact summary</summary>" }, null));
				response.write(chunk({}, "stop"));
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const { port } = server.address() as AddressInfo;
			const catalogModel: Model<"openai-completions"> = {
				id: "test-model",
				name: "Test model",
				api: "openai-completions",
				provider: "opencode-go",
				baseUrl: `http://127.0.0.1:${port}/v1`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4096,
			};
			const nativeProvider = opencodeGoProvider();
			harness = await createHarness({
				extensionFactories: [compactionExtension],
				settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			});
			seedCompactableSession(harness);
			harness.session.agent.state.model = catalogModel;
			await harness.authStorage.modify("opencode-go", async () => ({ type: "api_key", key: "test-key" }));
			harness.session.modelRuntime.registerNativeProvider({
				...nativeProvider,
				getModels: () => [catalogModel],
				getAllModels: () => [catalogModel],
			});
			await harness.session.modelRuntime.refresh({ allowNetwork: false, providers: ["opencode-go"] });

			await harness.session.compact();

			expect(received).toEqual([harness.session.sessionId]);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
