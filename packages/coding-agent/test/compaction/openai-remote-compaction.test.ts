import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import {
	buildOpenAiRemoteCompactionResult,
	buildOpenAiResponsesStreamCompactionResult,
	createOpenAiRemoteCompactionRequest,
	createOpenAiResponsesStreamCompactionPayload,
	OPENAI_REMOTE_COMPACTION_SCHEMA,
	rewriteOpenAiPayloadWithRemoteCompaction,
	runOpenAiRemoteCompaction,
} from "../../src/core/extensions/builtin/compaction/openai-remote.ts";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/types.ts";
import type { SessionEntry, SessionMessageEntry } from "../../src/core/session-manager.ts";

const OPENAI_MODEL = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
} satisfies Model<"openai-responses">;

function messageEntry(id: string, parentId: string | null, message: SessionMessageEntry["message"]): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(1_775_000_000_000 + id.length).toISOString(),
		message,
	};
}

function openAiBranch(): SessionEntry[] {
	return [
		{
			type: "model_change",
			id: "model",
			parentId: null,
			timestamp: new Date(1_775_000_000_000).toISOString(),
			provider: "openai",
			modelId: "gpt-5.4",
		},
		messageEntry("u1", "model", {
			role: "user",
			content: [{ type: "text", text: "Please inspect the build." }],
			timestamp: 1,
		}),
		messageEntry("a1", "u1", {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			content: [
				{
					type: "text",
					text: "I will inspect it.",
					textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
				},
				{ type: "toolCall", id: "call_build|fc_build", name: "bash", arguments: { cmd: "npm test" } },
			],
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		}),
		messageEntry("t1", "a1", {
			role: "toolResult",
			toolCallId: "call_build|fc_build",
			toolName: "bash",
			content: [{ type: "text", text: "Tests passed." }],
			isError: false,
			timestamp: 3,
		}),
		messageEntry("u2", "t1", {
			role: "user",
			content: [{ type: "text", text: "Great. Commit it." }],
			timestamp: 4,
		}),
	];
}

function compactionEvent(branchEntries: SessionEntry[]): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: true,
		requestId: "remote-test-request",
		preparation: {
			firstKeptEntryId: "u2",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1234,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries,
		signal: new AbortController().signal,
	};
}

describe("OpenAI remote compaction", () => {
	it("builds a compact request only when every context message is OpenAI Responses-compatible", () => {
		const request = createOpenAiRemoteCompactionRequest({
			model: OPENAI_MODEL,
			systemPrompt: "You are senpi.",
			branchEntries: openAiBranch(),
			tokensBefore: 1234,
			serviceTier: "priority" as const,
		});

		expect(request?.body.model).toBe("gpt-5.4");
		expect(request?.body.instructions).toBe("You are senpi.");
		expect(request?.body.service_tier).toBe("priority");
		expect(request?.body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Please inspect the build." }] },
			{
				type: "message",
				role: "assistant",
				status: "completed",
				id: "msg_1",
				phase: "commentary",
				content: [{ type: "output_text", text: "I will inspect it.", annotations: [] }],
			},
			{
				type: "function_call",
				id: "fc_build",
				call_id: "call_build",
				name: "bash",
				arguments: '{"cmd":"npm test"}',
			},
			{ type: "function_call_output", call_id: "call_build", output: "Tests passed." },
			{ role: "user", content: [{ type: "input_text", text: "Great. Commit it." }] },
		]);
	});

	it("omits the sentinel id when replaying a custom tool call as a function call", () => {
		// Custom tool calls are stored with the "<call_id>|custom" id sentinel
		// (processResponsesStream). The Responses API rejects any function_call
		// item id not beginning with "fc", so the remote-compaction replay must
		// omit the sentinel instead of failing the whole compaction request.
		const branch: SessionEntry[] = [
			{
				type: "model_change",
				id: "model",
				parentId: null,
				timestamp: new Date(1_775_000_000_000).toISOString(),
				provider: "openai",
				modelId: "gpt-5.4",
			},
			messageEntry("u1", "model", {
				role: "user",
				content: [{ type: "text", text: "Patch it." }],
				timestamp: 1,
			}),
			messageEntry("a1", "u1", {
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
				content: [
					{
						type: "toolCall",
						id: "call_patch|custom",
						name: "apply_patch",
						arguments: { input: "*** Begin Patch\n*** End Patch" },
					},
				],
				usage: {
					input: 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 120,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			}),
			messageEntry("t1", "a1", {
				role: "toolResult",
				toolCallId: "call_patch|custom",
				toolName: "apply_patch",
				content: [{ type: "text", text: "patch applied" }],
				isError: false,
				timestamp: 3,
			}),
		];

		const request = createOpenAiRemoteCompactionRequest({
			model: OPENAI_MODEL,
			systemPrompt: "You are senpi.",
			branchEntries: branch,
			tokensBefore: 1234,
		});

		expect(request?.body.input).toContainEqual({
			type: "function_call",
			call_id: "call_patch",
			name: "apply_patch",
			arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
		});
		expect(request?.body.input).toContainEqual({
			type: "function_call_output",
			call_id: "call_patch",
			output: "patch applied",
		});
	});

	it("builds a Codex-style Responses WebSocket compaction payload", () => {
		const request = createOpenAiRemoteCompactionRequest({
			model: OPENAI_MODEL,
			systemPrompt: "You are senpi.",
			branchEntries: openAiBranch(),
			tokensBefore: 1234,
			promptCacheKey: "session-1",
			serviceTier: "priority",
		});

		expect(request).toBeDefined();
		if (!request) return;

		const payload = createOpenAiResponsesStreamCompactionPayload(
			{
				model: "gpt-5.4",
				input: [{ role: "developer", content: "current system prompt" }],
				stream: true,
			},
			request,
		);

		expect(payload).toMatchObject({
			model: "gpt-5.4",
			prompt_cache_key: "session-1",
			service_tier: "priority",
			input: [
				{ role: "developer", content: "current system prompt" },
				{ role: "user", content: [{ type: "input_text", text: "Please inspect the build." }] },
				{
					type: "message",
					role: "assistant",
					status: "completed",
					id: "msg_1",
					phase: "commentary",
					content: [{ type: "output_text", text: "I will inspect it.", annotations: [] }],
				},
				{
					type: "function_call",
					id: "fc_build",
					call_id: "call_build",
					name: "bash",
					arguments: '{"cmd":"npm test"}',
				},
				{ type: "function_call_output", call_id: "call_build", output: "Tests passed." },
				{ role: "user", content: [{ type: "input_text", text: "Great. Commit it." }] },
				{ type: "context_compaction" },
			],
			stream: true,
		});
	});

	it("uses the Responses WebSocket compaction route before the compact endpoint", async () => {
		const emitted: unknown[] = [];
		const capturedPayloads: unknown[] = [];
		const ctx = {
			model: OPENAI_MODEL,
			serviceTier: "priority" as const,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
			},
			sessionManager: { getSessionId: () => "session-1" },
			getSystemPrompt: () => "You are senpi.",
		};

		const result = await runOpenAiRemoteCompaction(
			ctx,
			compactionEvent(openAiBranch()),
			(event) => emitted.push(event),
			{
				fetch: async () => {
					throw new Error("compact endpoint should not be called when websocket compaction succeeds");
				},
				now: () => 1_775_000_001_000,
				streamRunner: (_model, _context, options) => ({
					result: async () => {
						const payload = await options.onPayload?.(
							{
								model: "gpt-5.4",
								input: [{ role: "developer", content: "current system prompt" }],
								stream: true,
							},
							OPENAI_MODEL,
						);
						capturedPayloads.push(payload);
						return {
							role: "assistant",
							api: "openai-responses",
							provider: "openai",
							model: "gpt-5.4",
							responseId: "resp_ws_compact",
							content: [
								{
									type: "providerNative",
									subtype: "context_compaction",
									raw: { type: "context_compaction", encrypted_content: "encrypted-websocket-summary" },
								},
							],
							usage: {
								input: 1000,
								output: 50,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 1050,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: 1_775_000_001_000,
						} satisfies AssistantMessage;
					},
				}),
			},
		);

		expect(result?.details.transport).toBe("websocket");
		expect(capturedPayloads).toHaveLength(1);
		expect(capturedPayloads[0]).toMatchObject({
			service_tier: "priority",
			input: expect.arrayContaining([{ type: "context_compaction" }]),
		});
		expect(emitted).toMatchObject([
			{ action: "remote_started", transport: "websocket" },
			{ action: "remote_completed", transport: "websocket" },
		]);
	});

	it("falls back when the compact endpoint does not respond before the remote timeout", async () => {
		const emitted: unknown[] = [];
		const compactOnlyModel = {
			...OPENAI_MODEL,
			baseUrl: "https://ccapi.example.com/v1",
			compat: { supportsWebSocket: false },
		} satisfies Model<"openai-responses">;
		const ctx = {
			model: compactOnlyModel,
			serviceTier: undefined,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
			},
			sessionManager: { getSessionId: () => "session-1" },
			getSystemPrompt: () => "You are senpi.",
		};

		const result = await runOpenAiRemoteCompaction(
			ctx,
			compactionEvent(openAiBranch()),
			(event) => emitted.push(event),
			{
				fetch: (_url, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
					}),
				remoteTimeoutMs: 1,
			},
		);

		expect(result).toBeUndefined();
		expect(emitted).toMatchObject([
			{ action: "remote_started", transport: "compact-endpoint" },
			{
				action: "remote_fallback",
				transport: "compact-endpoint",
				reason: "remote-compaction-timeout",
			},
		]);
	});

	it("falls back when a non-OpenAI assistant message is present", () => {
		const branch = openAiBranch();
		branch.splice(
			2,
			1,
			messageEntry("anthropic", "u1", {
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-4-7",
				content: [{ type: "text", text: "not native" }],
				usage: {
					input: 10,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 12,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			}),
		);

		expect(
			createOpenAiRemoteCompactionRequest({
				model: OPENAI_MODEL,
				systemPrompt: "You are senpi.",
				branchEntries: branch,
				tokensBefore: 1234,
			}),
		).toBeUndefined();
	});

	it("stores remote compaction replacement input in result details for replay", () => {
		const result = buildOpenAiRemoteCompactionResult({
			model: OPENAI_MODEL,
			firstKeptEntryId: "u2",
			tokensBefore: 1234,
			requestInputItemCount: 5,
			response: {
				id: "resp_compact",
				created_at: 1_775_000_001,
				object: "response.compaction",
				output: [
					{
						type: "message",
						id: "u1_remote",
						role: "user",
						content: [{ type: "input_text", text: "Please inspect the build." }],
					},
					{ type: "compaction", id: "cmp_1", encrypted_content: "encrypted-summary" },
				],
				usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 },
			},
		});

		expect(result.summary).toContain("OpenAI remote compaction");
		expect(result.details.schema).toBe(OPENAI_REMOTE_COMPACTION_SCHEMA);
		expect(result.details.replacementInput).toEqual([
			{
				type: "message",
				id: "u1_remote",
				role: "user",
				content: [{ type: "input_text", text: "Please inspect the build." }],
			},
			{ type: "compaction", id: "cmp_1", encrypted_content: "encrypted-summary" },
		]);
	});

	it("stores Responses WebSocket context_compaction output in result details for replay", () => {
		const response = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			responseId: "resp_ws_compact",
			content: [
				{
					type: "providerNative",
					subtype: "context_compaction",
					raw: { type: "context_compaction", encrypted_content: "encrypted-websocket-summary" },
				},
			],
			usage: {
				input: 1000,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1050,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1_775_000_001_000,
		} satisfies AssistantMessage;

		const result = buildOpenAiResponsesStreamCompactionResult({
			model: OPENAI_MODEL,
			firstKeptEntryId: "u2",
			tokensBefore: 1234,
			requestInput:
				createOpenAiRemoteCompactionRequest({
					model: OPENAI_MODEL,
					systemPrompt: "You are senpi.",
					branchEntries: openAiBranch(),
					tokensBefore: 1234,
				})?.body.input ?? [],
			response,
			now: () => 1_775_000_001_000,
		});

		expect(result.summary).toContain("Responses WebSocket");
		expect(result.details.transport).toBe("websocket");
		expect(result.details.requestInputItemCount).toBe(5);
		expect(result.details.replacementInput).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Please inspect the build." }] },
			{ role: "user", content: [{ type: "input_text", text: "Great. Commit it." }] },
			{ type: "context_compaction", encrypted_content: "encrypted-websocket-summary" },
		]);
	});

	it("rewrites provider payloads to replay native compacted history plus post-compact messages", () => {
		const remoteResult = buildOpenAiRemoteCompactionResult({
			model: OPENAI_MODEL,
			firstKeptEntryId: "u2",
			tokensBefore: 1234,
			requestInputItemCount: 5,
			response: {
				id: "resp_compact",
				created_at: 1_775_000_001,
				object: "response.compaction",
				output: [
					{
						type: "message",
						id: "u1_remote",
						role: "user",
						content: [{ type: "input_text", text: "Please inspect the build." }],
					},
					{ type: "compaction", id: "cmp_1", encrypted_content: "encrypted-summary" },
				],
			},
		});
		const branchWithRemoteCompaction: SessionEntry[] = [
			...openAiBranch(),
			{
				type: "compaction",
				id: "compact",
				parentId: "u2",
				timestamp: new Date(1_775_000_002_000).toISOString(),
				summary: remoteResult.summary,
				firstKeptEntryId: remoteResult.firstKeptEntryId,
				tokensBefore: remoteResult.tokensBefore,
				details: remoteResult.details,
				fromHook: true,
			},
			messageEntry("u3", "compact", {
				role: "user",
				content: [{ type: "text", text: "Continue after compaction." }],
				timestamp: 5,
			}),
		];

		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(
			{
				model: "gpt-5.4",
				input: [
					{ role: "developer", content: "current system prompt" },
					{ role: "user", content: [{ type: "input_text", text: "fallback compact summary" }] },
				],
				stream: true,
			},
			{ model: OPENAI_MODEL, branchEntries: branchWithRemoteCompaction },
		);

		expect(rewritten).toMatchObject({
			model: "gpt-5.4",
			input: [
				{ role: "developer", content: "current system prompt" },
				{
					type: "message",
					id: "u1_remote",
					role: "user",
					content: [{ type: "input_text", text: "Please inspect the build." }],
				},
				{ type: "compaction", id: "cmp_1", encrypted_content: "encrypted-summary" },
				{ role: "user", content: [{ type: "input_text", text: "Continue after compaction." }] },
			],
			stream: true,
		});
	});
});
