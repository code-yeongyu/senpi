import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	createSpeculativeCompactionSnapshot,
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const PROVIDER = "anthropic-compaction-wire";
const MODEL_ID = "claude-compaction-wire";
const ORPHAN_TOOL_USE_ID = "tool_MT8C3KqVPHoD0Xw5GLGvSQBO";
const SUMMARY_TEXT = "Anthropic compaction summary.";

type AnthropicBlock = {
	type?: unknown;
	id?: unknown;
	tool_use_id?: unknown;
};

type AnthropicMessage = {
	role?: unknown;
	content?: unknown;
};

type AnthropicRequestBody = {
	messages?: unknown;
};

function findOrphanToolResult(body: AnthropicRequestBody): string | undefined {
	if (!Array.isArray(body.messages)) return undefined;
	for (let index = 0; index < body.messages.length; index++) {
		const message = body.messages[index] as AnthropicMessage;
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		const previous = body.messages[index - 1] as AnthropicMessage | undefined;
		const precedingToolUseIds = new Set(
			previous?.role === "assistant" && Array.isArray(previous.content)
				? previous.content.flatMap((block: AnthropicBlock) =>
						block.type === "tool_use" && typeof block.id === "string" ? [block.id] : [],
					)
				: [],
		);
		for (const block of message.content as AnthropicBlock[]) {
			if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
			if (!precedingToolUseIds.has(block.tool_use_id)) return block.tool_use_id;
		}
	}
	return undefined;
}

function writeEvent(response: import("node:http").ServerResponse, event: string, payload: unknown): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function writeSummary(response: import("node:http").ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	writeEvent(response, "message_start", {
		type: "message_start",
		message: {
			id: "msg_compaction",
			usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	});
	writeEvent(response, "content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	});
	writeEvent(response, "content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: SUMMARY_TEXT },
	});
	writeEvent(response, "content_block_stop", { type: "content_block_stop", index: 0 });
	writeEvent(response, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	});
	writeEvent(response, "message_stop", { type: "message_stop" });
	response.end();
}

function startAnthropicServer(): Promise<{
	readonly url: string;
	readonly bodies: AnthropicRequestBody[];
	readonly rejectedToolUseIds: string[];
	stop(): Promise<void>;
}> {
	const bodies: AnthropicRequestBody[] = [];
	const rejectedToolUseIds: string[] = [];
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequestBody;
			bodies.push(body);
			const orphanToolUseId = findOrphanToolResult(body);
			if (orphanToolUseId) {
				rejectedToolUseIds.push(orphanToolUseId);
				response.writeHead(400, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: `unexpected tool_use_id found in tool_result blocks: ${orphanToolUseId}`,
						},
					}),
				);
				return;
			}
			writeSummary(response);
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				bodies,
				rejectedToolUseIds,
				stop: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

function createContext(serverUrl: string): SpeculativeCompactionContext {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(PROVIDER, "wire-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(PROVIDER, {
		baseUrl: serverUrl,
		apiKey: "wire-key",
		api: "anthropic-messages",
		models: [
			{
				id: MODEL_ID,
				name: "Claude compaction wire",
				api: "anthropic-messages",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 16_384,
				baseUrl: serverUrl,
			},
		],
	});
	const model = modelRegistry.find(PROVIDER, MODEL_ID);
	if (!model) throw new Error("Anthropic compaction wire model registration failed");

	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first user ".repeat(12_000) }],
		timestamp: Date.now() - 3_000,
	});
	const interruptedAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: PROVIDER,
		model: MODEL_ID,
		usage: {
			input: 50_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 50_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "terminated",
		timestamp: Date.now() - 2_000,
	};
	sessionManager.appendMessage(interruptedAssistant);
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: ORPHAN_TOOL_USE_ID,
		toolName: "task",
		content: [{ type: "text", text: "orphaned child result" }],
		isError: false,
		timestamp: Date.now() - 1_500,
	});
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "second user ".repeat(12_000) }],
		timestamp: Date.now() - 1_000,
	});

	return {
		model,
		modelRegistry,
		sessionManager,
		getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
}

describe("Anthropic compaction tool-pair guard", () => {
	let server: Awaited<ReturnType<typeof startAnthropicServer>> | undefined;

	afterEach(async () => {
		await server?.stop();
		server = undefined;
	});

	it("removes an orphan tool_result before the summarization request reaches Anthropic", async () => {
		// Given
		server = await startAnthropicServer();
		const context = createContext(server.url);
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		expect(snapshot).toBeDefined();
		if (!snapshot) return;

		// When
		const result = await runExtensionCompaction(context, snapshot);

		// Then
		expect(result?.summary).toBe(SUMMARY_TEXT);
		expect(server.rejectedToolUseIds).toEqual([]);
		expect(server.bodies.some((body) => findOrphanToolResult(body) === ORPHAN_TOOL_USE_ID)).toBe(false);
	});
});
