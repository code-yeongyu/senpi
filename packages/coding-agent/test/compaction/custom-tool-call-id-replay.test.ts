import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	createSpeculativeCompactionSnapshot,
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Reproduces the production failure where a compaction summarization request
 * replayed a custom tool call (stored with the "<call_id>|custom" sentinel) as
 * a function_call item with id "custom", and the OpenAI Responses API rejected
 * the whole request:
 *   Invalid 'input[166].id': 'custom'. Expected an ID that begins with 'fc'.
 *
 * The wiremock server applies the API's id rule to every function_call input
 * item and answers 400 with that exact error shape when violated, so this test
 * fails against the real wire path whenever an invalid id leaks into a request.
 */

const PROVIDER = "openai";
const MODEL_ID = "gpt-5.4";
const SUMMARY_TEXT = "Wiremock compaction summary: patch applied.";

interface WiremockRequestBody {
	input?: unknown;
	model?: unknown;
}

interface InputItem {
	type?: string;
	id?: unknown;
	name?: unknown;
}

function findInvalidFunctionCallId(input: unknown): { index: number; id: string } | undefined {
	if (!Array.isArray(input)) return undefined;
	for (let index = 0; index < input.length; index++) {
		const item = input[index] as InputItem | null;
		if (item?.type === "function_call" && typeof item.id === "string" && !item.id.startsWith("fc")) {
			return { index, id: item.id };
		}
	}
	return undefined;
}

function startWiremockServer(): Promise<{ url: string; bodies: WiremockRequestBody[]; stop: () => Promise<void> }> {
	const bodies: WiremockRequestBody[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const body = (raw ? JSON.parse(raw) : {}) as WiremockRequestBody;
			bodies.push(body);

			const invalid = findInvalidFunctionCallId(body.input);
			if (invalid) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						error: {
							message: `Invalid 'input[${invalid.index}].id': '${invalid.id}'. Expected an ID that begins with 'fc'.`,
							type: "invalid_request_error",
							param: `input[${invalid.index}].id`,
							code: "invalid_value",
						},
					}),
				);
				return;
			}

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			let seq = 0;
			const emit = (type: string, data: Record<string, unknown>) =>
				res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
			const modelId = typeof body.model === "string" ? body.model : MODEL_ID;
			const responseId = "resp_wiremock";
			const itemId = "msg_wiremock";
			emit("response.created", {
				response: { id: responseId, object: "response", status: "in_progress", model: modelId, output: [] },
			});
			emit("response.output_item.added", {
				output_index: 0,
				item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
			});
			emit("response.content_part.added", {
				item_id: itemId,
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			});
			emit("response.output_text.delta", {
				item_id: itemId,
				output_index: 0,
				content_index: 0,
				delta: SUMMARY_TEXT,
			});
			const doneItem = {
				id: itemId,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: SUMMARY_TEXT, annotations: [] }],
			};
			emit("response.output_item.done", { output_index: 0, item: doneItem });
			emit("response.completed", {
				response: {
					id: responseId,
					object: "response",
					status: "completed",
					model: modelId,
					output: [doneItem],
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				},
			});
			res.end();
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${address.port}/v1`,
				bodies,
				stop: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

function createWiremockContext(serverUrl: string): SpeculativeCompactionContext {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(PROVIDER, "wiremock-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(PROVIDER, {
		baseUrl: serverUrl,
		apiKey: "wiremock-key",
		api: "openai-responses",
		models: [
			{
				id: MODEL_ID,
				name: "GPT-5.4",
				api: "openai-responses",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 16_384,
				baseUrl: serverUrl,
			},
		],
	});
	const model = modelRegistry.find(PROVIDER, MODEL_ID);
	if (!model) throw new Error("wiremock model registration failed");

	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first user ".repeat(12_000) }],
		timestamp: Date.now() - 3_000,
	});
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "Applying the patch now." },
			{
				type: "toolCall",
				id: "call_patch|custom",
				name: "apply_patch",
				arguments: { input: "*** Begin Patch\n*** End Patch" },
			},
		],
		api: "openai-responses",
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
		stopReason: "toolUse",
		timestamp: Date.now() - 2_000,
	};
	sessionManager.appendMessage(assistant);
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call_patch|custom",
		toolName: "apply_patch",
		content: [{ type: "text", text: "patch applied" }],
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

describe("compaction replay of custom tool calls over the wire", () => {
	let server: { url: string; bodies: WiremockRequestBody[]; stop: () => Promise<void> } | undefined;

	afterEach(async () => {
		await server?.stop();
		server = undefined;
	});

	it("replays a custom-tool-call history without invalid Responses item ids", async () => {
		server = await startWiremockServer();
		const context = createWiremockContext(server.url);
		// getSummarizationTools() strips `freeform` — mirror that exact shape.
		const snapshot = createSpeculativeCompactionSnapshot(context, {
			generation: 1,
			tools: [
				{
					name: "apply_patch",
					description: "Apply a patch to files.",
					parameters: Type.Object({ input: Type.String() }),
				},
			],
		});
		expect(snapshot).toBeDefined();
		if (!snapshot) return;

		const result = await runExtensionCompaction(context, snapshot, undefined);

		expect(result?.summary).toBe(SUMMARY_TEXT);
		expect(server.bodies.length).toBeGreaterThan(0);
		const inputs = server.bodies.flatMap((body) => (Array.isArray(body.input) ? (body.input as InputItem[]) : []));
		// Vacuous-test guard: the poisoned call must actually reach the wire.
		expect(inputs.some((item) => item.type === "function_call" && item.name === "apply_patch")).toBe(true);
		for (const item of inputs) {
			if (item.type === "function_call" && typeof item.id === "string") {
				expect(item.id.startsWith("fc")).toBe(true);
			}
		}
	});
});
