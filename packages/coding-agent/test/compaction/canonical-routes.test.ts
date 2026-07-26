import { type AssistantMessage, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertResponsesMessages } from "../../../ai/src/api/openai-responses-shared.ts";
import { type CompactionResult, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import {
	buildOpenAiRemoteCompactionResult,
	markOpenAiRemoteReplayBoundary,
	rewriteOpenAiPayloadWithRemoteCompaction,
} from "../../src/core/extensions/builtin/compaction/openai-remote.ts";
import {
	createOpenAiRemoteCompactionHeaders,
	openAiRemoteCompactionOrigin,
} from "../../src/core/extensions/builtin/compaction/openai-remote-model.ts";
import type { BeforeAgentStartEvent } from "../../src/core/extensions/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, convertToLlm } from "../../src/core/messages.ts";
import {
	buildSessionContext,
	type SessionEntry,
	type SessionMessageEntry,
	sessionEntryToContextMessages,
} from "../../src/core/session-manager.ts";
import { createHarness } from "../suite/harness.ts";

const OPENAI_MODEL = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "http://openai.test/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_024,
} satisfies Model<"openai-responses">;

afterEach(() => {
	vi.unstubAllGlobals();
});

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
	const assistant = {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: OPENAI_MODEL.id,
		content: [{ type: "text", text: "I inspected the build. ".repeat(1_000) }],
		usage: {
			input: 200,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 220,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	} satisfies AssistantMessage;

	return [
		{
			type: "model_change",
			id: "model",
			parentId: null,
			timestamp: new Date(1_775_000_000_000).toISOString(),
			provider: "openai",
			modelId: OPENAI_MODEL.id,
		},
		messageEntry("u1", "model", {
			role: "user",
			content: [{ type: "text", text: "Please inspect the build. ".repeat(1_000) }],
			timestamp: 1,
		}),
		messageEntry("a1", "u1", assistant),
		messageEntry("u2", "a1", {
			role: "user",
			content: [{ type: "text", text: "Continue after compaction." }],
			timestamp: 3,
		}),
	];
}

async function loadBeforeAgentStartHandler(): Promise<
	(event: BeforeAgentStartEvent, ctx: unknown) => Promise<unknown>
> {
	const extension = await loadExtensionFromFactory(
		compactionExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<builtin:compaction>",
	);
	const handler = extension.handlers.get("before_agent_start")?.[0];
	if (!handler) {
		throw new Error("builtin compaction before_agent_start handler was not registered");
	}
	return async (event, ctx) => await handler(event, ctx);
}

describe("builtin compaction canonical routes", () => {
	it("uses OpenAI remote compaction before provider submission when the pending prompt would exceed the hard limit", async () => {
		const branchEntries = openAiBranch();
		const appliedCompactions: CompactionResult[] = [];
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					id: "resp_compact",
					object: "response.compaction",
					created_at: 1_775_000_001,
					output: [{ type: "context_compaction", encrypted_content: "encrypted-summary" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const handler = await loadBeforeAgentStartHandler();
		await handler(
			{
				type: "before_agent_start",
				prompt: "incoming prompt ".repeat(1_500),
				systemPrompt: "You are senpi.",
				systemPromptOptions: { cwd: process.cwd() },
			},
			{
				model: OPENAI_MODEL,
				serviceTier: undefined,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
				},
				sessionManager: {
					getBranch: () => branchEntries,
					getEntries: () => branchEntries,
					getSessionId: () => "session-1",
				},
				getContextUsage: () => ({ tokens: 3_000, contextWindow: 10_000, percent: 30 }),
				getCompactionSettings: () => ({
					...DEFAULT_COMPACTION_SETTINGS,
					keepRecentTokens: 200,
					reserveTokens: 2_000,
				}),
				getMessageRevision: () => 1,
				getSystemPrompt: () => "You are senpi.",
				beginCompaction: () => new AbortController().signal,
				endCompaction: () => {},
				applyCompaction: async (compaction: CompactionResult) => {
					appliedCompactions.push(compaction);
					return { applied: true as const, reason: "ok" as const };
				},
				ui: { notify: () => {} },
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(appliedCompactions).toHaveLength(1);
		expect(appliedCompactions[0]?.details).toMatchObject({
			schema: "senpi.compaction.openai-remote.v1",
			mode: "openai-remote",
			transport: "compact-endpoint",
			origin: {
				endpoint: "http://openai.test/v1",
				trustDomain: "http://openai.test",
				authTenantFingerprint: expect.stringMatching(/^sha256:/),
			},
		});
	});

	it("retains the current prompt after a checkpoint prefix whose failed turns Responses drops", () => {
		const currentPrompt = "CURRENT_PROMPT_MUST_APPEAR_ONCE";
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const branch: SessionEntry[] = [
			messageEntry("u1", null, {
				role: "user",
				content: [{ type: "text", text: "kept checkpoint context" }],
				timestamp: 1,
			}),
			messageEntry("error", "u1", {
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: OPENAI_MODEL.id,
				content: [
					{ type: "text", text: "ERRORED_ASSISTANT_SHOULD_NOT_REPLAY" },
					{ type: "toolCall", id: "call_error|fc_error", name: "read", arguments: {} },
				],
				usage,
				stopReason: "error",
				timestamp: 2,
			}),
			messageEntry("error-result", "error", {
				role: "toolResult",
				toolCallId: "call_error|fc_error",
				toolName: "read",
				content: [{ type: "text", text: "ERRORED_TOOL_RESULT_SHOULD_NOT_REPLAY" }],
				isError: true,
				timestamp: 3,
			}),
			messageEntry("aborted", "error-result", {
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: OPENAI_MODEL.id,
				content: [
					{ type: "text", text: "ABORTED_ASSISTANT_SHOULD_NOT_REPLAY" },
					{ type: "toolCall", id: "call_abort|fc_abort", name: "read", arguments: {} },
				],
				usage,
				stopReason: "aborted",
				timestamp: 4,
			}),
			messageEntry("aborted-result", "aborted", {
				role: "toolResult",
				toolCallId: "call_abort|fc_abort",
				toolName: "read",
				content: [{ type: "text", text: "ABORTED_TOOL_RESULT_SHOULD_NOT_REPLAY" }],
				isError: true,
				timestamp: 5,
			}),
			messageEntry("empty", "aborted-result", {
				role: "user",
				content: [],
				timestamp: 6,
			}),
			{
				type: "compaction",
				id: "checkpoint",
				parentId: "empty",
				timestamp: new Date(1_775_000_001_000).toISOString(),
				summary: "fallback checkpoint summary",
				firstKeptEntryId: "u1",
				tokensBefore: 100,
				fromHook: true,
				details: {
					schema: "senpi.compaction.openai-remote.v1",
					mode: "openai-remote",
					provider: "openai",
					api: "openai-responses",
					transport: "compact-endpoint",
					modelId: OPENAI_MODEL.id,
					responseId: "checkpoint-response",
					createdAt: 1_775_000_001,
					requestInputItemCount: 1,
					retainedInputItemCount: 1,
					replacementInput: [{ type: "compaction", encrypted_content: "provider-checkpoint" }],
				},
			},
		];

		const checkpointIndex = branch.findIndex((entry) => entry.id === "checkpoint");
		const canonicalInput = convertResponsesMessages(
			OPENAI_MODEL,
			{
				systemPrompt: "current system prompt",
				messages: [
					...convertToLlm(
						[branch[checkpointIndex]!, ...branch.slice(0, checkpointIndex)].flatMap(
							sessionEntryToContextMessages,
						),
					),
					{ role: "user", content: [{ type: "text", text: currentPrompt }], timestamp: 7 },
				],
			},
			new Set(["openai"]),
		);
		const canonicalPayload = JSON.stringify(canonicalInput);
		expect(canonicalPayload).not.toContain("ERRORED_ASSISTANT_SHOULD_NOT_REPLAY");
		expect(canonicalPayload).not.toContain("ERRORED_TOOL_RESULT_SHOULD_NOT_REPLAY");
		expect(canonicalPayload).not.toContain("ABORTED_ASSISTANT_SHOULD_NOT_REPLAY");
		expect(canonicalPayload).not.toContain("ABORTED_TOOL_RESULT_SHOULD_NOT_REPLAY");

		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(
			{ model: OPENAI_MODEL.id, input: canonicalInput, stream: true },
			{ model: OPENAI_MODEL, branchEntries: branch },
		);

		// A manually reconstructed payload has no request-local boundary marker.
		// It is intentionally not enough to carry equal provider items.
		expect(rewritten).toBeUndefined();
	});

	it("uses the canonical projection for the checkpoint prefix when a newer checkpoint supersedes an older compaction", () => {
		const currentPrompt = "CURRENT_PROMPT_MUST_APPEAR_ONCE";
		const firstPostCheckpoint = "FIRST_POST_CHECKPOINT_ITEM";
		const olderRemote = buildOpenAiRemoteCompactionResult({
			model: OPENAI_MODEL,
			firstKeptEntryId: "u2",
			tokensBefore: 100,
			requestInputItemCount: 3,
			response: {
				id: "resp_older",
				created_at: 1_775_000_001,
				object: "response.compaction",
				output: [{ type: "compaction", id: "cmp_older", encrypted_content: "OLDER_CHECKPOINT_SUPERSEDED" }],
			},
		});
		const latestRemote = buildOpenAiRemoteCompactionResult({
			model: OPENAI_MODEL,
			firstKeptEntryId: "u1",
			tokensBefore: 200,
			requestInputItemCount: 6,
			response: {
				id: "resp_latest",
				created_at: 1_775_000_002,
				object: "response.compaction",
				output: [{ type: "compaction", id: "cmp_latest", encrypted_content: "LATEST_CHECKPOINT" }],
			},
		});
		// The latest checkpoint's firstKeptEntryId (u1) reaches before the older
		// compaction entry, so the older summary is superseded.
		const branch: SessionEntry[] = [
			{
				type: "model_change",
				id: "model",
				parentId: null,
				timestamp: new Date(1_775_000_000_000).toISOString(),
				provider: "openai",
				modelId: OPENAI_MODEL.id,
			},
			messageEntry("u1", "model", {
				role: "user",
				content: [{ type: "text", text: "kept turn one" }],
				timestamp: 1,
			}),
			messageEntry("a1", "u1", {
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: OPENAI_MODEL.id,
				content: [{ type: "text", text: "kept assistant one" }],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			}),
			messageEntry("u2", "a1", {
				role: "user",
				content: [{ type: "text", text: "kept turn two" }],
				timestamp: 3,
			}),
			{
				type: "compaction",
				id: "compact-older",
				parentId: "u2",
				timestamp: new Date(1_775_000_001_000).toISOString(),
				summary: "OLDER_SUMMARY_SUPERSEDED",
				firstKeptEntryId: olderRemote.firstKeptEntryId,
				tokensBefore: olderRemote.tokensBefore,
				details: olderRemote.details,
				fromHook: true,
			},
			messageEntry("u3", "compact-older", {
				role: "user",
				content: [{ type: "text", text: "kept turn three" }],
				timestamp: 4,
			}),
			messageEntry("u4", "u3", {
				role: "user",
				content: [{ type: "text", text: "kept turn four" }],
				timestamp: 5,
			}),
			{
				type: "compaction",
				id: "compact-latest",
				parentId: "u4",
				timestamp: new Date(1_775_000_002_000).toISOString(),
				summary: "LATEST_SUMMARY",
				firstKeptEntryId: latestRemote.firstKeptEntryId,
				tokensBefore: latestRemote.tokensBefore,
				details: latestRemote.details,
				fromHook: true,
			},
			messageEntry("u5", "compact-latest", {
				role: "user",
				content: [{ type: "text", text: firstPostCheckpoint }],
				timestamp: 6,
			}),
		];

		// Canonical session context skips the superseded older summary.
		const canonicalMessages = convertToLlm(buildSessionContext(branch).messages);
		const canonicalText = JSON.stringify(canonicalMessages);
		expect(canonicalText).toContain("LATEST_SUMMARY");
		expect(canonicalText).not.toContain("OLDER_SUMMARY_SUPERSEDED");
		expect(canonicalText).toContain("kept turn one");
		expect(canonicalText).toContain(firstPostCheckpoint);

		const canonicalInput = convertResponsesMessages(
			OPENAI_MODEL,
			{
				systemPrompt: "current system prompt",
				messages: [
					...canonicalMessages,
					{ role: "user", content: [{ type: "text", text: currentPrompt }], timestamp: 7 },
				],
			},
			new Set(["openai"]),
		);

		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(
			{ model: OPENAI_MODEL.id, input: canonicalInput, stream: true },
			{ model: OPENAI_MODEL, branchEntries: branch },
		);

		// The compaction projection alone is not provenance. Only the actual
		// context pipeline may authorize replay.
		expect(rewritten).toBeUndefined();
	});

	it("declines remote checkpoint replay when context hooks change the checkpoint prefix boundary", async () => {
		const filteredPrefix = "FILTERED_CHECKPOINT_PREFIX";
		const injectedPrefixOne = "INJECTED_CHECKPOINT_PREFIX_ONE";
		const injectedPrefixTwo = "INJECTED_CHECKPOINT_PREFIX_TWO";
		const postCheckpointMessage = "POST_CHECKPOINT_MESSAGE_MUST_APPEAR_ONCE";
		const currentPrompt = "CURRENT_PROMPT_MUST_APPEAR_ONCE";
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [
				{ id: OPENAI_MODEL.id, contextWindow: OPENAI_MODEL.contextWindow, maxTokens: OPENAI_MODEL.maxTokens },
			],
			extensionFactories: [
				compactionExtension,
				(pi) => {
					pi.on("context", (event) => {
						const withoutFilteredPrefix = event.messages.filter((message) => {
							if (message.role !== "user" || typeof message.content === "string") return true;
							return !message.content.some((part) => part.type === "text" && part.text.includes(filteredPrefix));
						});
						return {
							// The transformed checkpoint prefix is no longer identifiable by
							// persisted-entry count: one item was removed and two injected.
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: injectedPrefixOne }],
									timestamp: 10,
								},
								{
									role: "user",
									content: [{ type: "text", text: injectedPrefixTwo }],
									timestamp: 11,
								},
								...withoutFilteredPrefix,
							],
						};
					});
				},
			],
		});

		try {
			const model = harness.getModel() as Model<"openai-responses">;
			const retainedEntryId = harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: filteredPrefix }],
				timestamp: 1,
			});
			const checkpoint = buildOpenAiRemoteCompactionResult({
				model,
				firstKeptEntryId: retainedEntryId,
				tokensBefore: 1_234,
				requestInputItemCount: 1,
				response: {
					id: "resp_checkpoint",
					created_at: 1_775_000_001,
					object: "response.compaction",
					output: [{ type: "compaction", id: "cmp_checkpoint", encrypted_content: "provider-checkpoint" }],
				},
			});
			harness.sessionManager.appendCompaction(
				checkpoint.summary,
				checkpoint.firstKeptEntryId,
				checkpoint.tokensBefore,
				checkpoint.details,
				true,
			);
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: postCheckpointMessage }],
				timestamp: 2,
			});

			const finalContext = await harness
				.getExtensionRunner()
				.emitContext([
					...harness.sessionManager.buildSessionContext().messages,
					{ role: "user", content: [{ type: "text", text: currentPrompt }], timestamp: 3 },
				]);
			const finalProviderInput = convertResponsesMessages(
				model,
				{ systemPrompt: "current system prompt", messages: convertToLlm(finalContext) },
				new Set(["openai"]),
			);
			const finalPayload = { model: model.id, input: finalProviderInput, stream: true };
			const finalPayloadText = JSON.stringify(finalPayload);
			expect(finalPayloadText).not.toContain(filteredPrefix);
			expect(finalPayloadText).toContain(injectedPrefixOne);
			expect(finalPayloadText).toContain(injectedPrefixTwo);

			const rewritten = await harness.getExtensionRunner().emitBeforeProviderRequest(finalPayload);

			// A count derived from persisted entries cannot prove this transformed
			// boundary. Preserve the final transformed payload instead of slicing it.
			expect(rewritten).toEqual(finalPayload);
			const outgoingPayload = JSON.stringify(rewritten);
			for (const text of [injectedPrefixOne, injectedPrefixTwo, postCheckpointMessage, currentPrompt]) {
				expect(outgoingPayload.split(text)).toHaveLength(2);
			}
			expect(outgoingPayload).not.toContain("provider-checkpoint");
		} finally {
			harness.cleanup();
		}
	});

	it("declines replay when a later context hook filters a retained prompt with the same text as the current prompt", async () => {
		const currentPrompt = "IDENTICAL_RETAINED_AND_CURRENT_PROMPT";
		let filteredPersistedPrompt = false;
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [
				{ id: OPENAI_MODEL.id, contextWindow: OPENAI_MODEL.contextWindow, maxTokens: OPENAI_MODEL.maxTokens },
			],
			extensionFactories: [
				compactionExtension,
				(pi) => {
					pi.on("context", (event) => {
						const messages = event.messages.filter((message) => {
							const isRetainedPrompt =
								message.role === "user" &&
								message.timestamp === 1 &&
								typeof message.content !== "string" &&
								message.content.some((part) => part.type === "text" && part.text === currentPrompt);
							if (isRetainedPrompt) filteredPersistedPrompt = true;
							return !isRetainedPrompt;
						});
						return { messages };
					});
				},
			],
		});

		try {
			const model = harness.getModel() as Model<"openai-responses">;
			const retainedEntryId = harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: currentPrompt }],
				timestamp: 1,
			});
			const checkpoint = buildOpenAiRemoteCompactionResult({
				model,
				firstKeptEntryId: retainedEntryId,
				tokensBefore: 1_234,
				requestInputItemCount: 1,
				response: {
					id: "resp_identical_prompt_checkpoint",
					created_at: 1_775_000_001,
					object: "response.compaction",
					output: [{ type: "compaction", id: "cmp_identical_prompt", encrypted_content: "provider-checkpoint" }],
				},
			});
			harness.sessionManager.appendCompaction(
				checkpoint.summary,
				checkpoint.firstKeptEntryId,
				checkpoint.tokensBefore,
				checkpoint.details,
				true,
			);

			const finalContext = await harness
				.getExtensionRunner()
				.emitContext([
					...harness.sessionManager.buildSessionContext().messages,
					{ role: "user", content: [{ type: "text", text: currentPrompt }], timestamp: 2 },
				]);
			const finalProviderInput = convertResponsesMessages(
				model,
				{ systemPrompt: "current system prompt", messages: convertToLlm(finalContext) },
				new Set(["openai"]),
			);
			const finalPayload = { model: model.id, input: finalProviderInput, stream: true };
			expect(filteredPersistedPrompt).toBe(true);
			expect(JSON.stringify(finalPayload).split(currentPrompt)).toHaveLength(2);

			const rewritten = await harness.getExtensionRunner().emitBeforeProviderRequest(finalPayload);

			// The timestamp-selected retained message is gone, even though the
			// in-flight prompt has identical text. Content equality alone cannot
			// establish the checkpoint boundary.
			expect(rewritten).toEqual(finalPayload);
			const outgoingPayload = JSON.stringify(rewritten);
			expect(outgoingPayload.split(currentPrompt)).toHaveLength(2);
			expect(outgoingPayload).not.toContain("provider-checkpoint");
		} finally {
			harness.cleanup();
		}
	});

	it("declines a checkpoint generated at endpoint A after the same effective model is reconfigured to endpoint B", () => {
		const endpointA = {
			...OPENAI_MODEL,
			baseUrl: "https://endpoint-a.example.test/v1",
		} satisfies Model<"openai-responses">;
		const endpointB = {
			...endpointA,
			baseUrl: "https://endpoint-b.example.test/v1",
		} satisfies Model<"openai-responses">;
		const retainedPrompt = "RETAINED_AT_ENDPOINT_A";
		const originA = openAiRemoteCompactionOrigin(endpointA, new Headers({ authorization: "Bearer tenant-a" }));
		const originB = openAiRemoteCompactionOrigin(endpointB, new Headers({ authorization: "Bearer tenant-a" }));
		expect(originA).toBeDefined();
		expect(originB).toBeDefined();
		if (!originA || !originB) return;
		const checkpoint = buildOpenAiRemoteCompactionResult({
			model: endpointA,
			firstKeptEntryId: "retained",
			tokensBefore: 1_234,
			requestInputItemCount: 1,
			response: {
				id: "resp_endpoint_a",
				created_at: 1_775_000_001,
				object: "response.compaction",
				output: [{ type: "compaction", id: "cmp_endpoint_a", encrypted_content: "endpoint-a-checkpoint" }],
			},
			origin: originA,
		});
		const branch: SessionEntry[] = [
			messageEntry("retained", null, {
				role: "user",
				content: [{ type: "text", text: retainedPrompt }],
				timestamp: 1,
			}),
			{
				type: "compaction",
				id: "checkpoint",
				parentId: "retained",
				timestamp: new Date(1_775_000_001_000).toISOString(),
				summary: checkpoint.summary,
				firstKeptEntryId: checkpoint.firstKeptEntryId,
				tokensBefore: checkpoint.tokensBefore,
				details: checkpoint.details,
				fromHook: true,
			},
		];
		const finalPayload = {
			model: endpointB.id,
			input: [
				{ role: "developer", content: "current system prompt" },
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: `${COMPACTION_SUMMARY_PREFIX}${checkpoint.summary}${COMPACTION_SUMMARY_SUFFIX}`,
						},
					],
				},
				{ role: "user", content: [{ type: "input_text", text: retainedPrompt }] },
			],
			stream: true,
		};

		const emitted: unknown[] = [];
		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(
			finalPayload,
			{ model: endpointB, branchEntries: branch, origin: originB },
			(event) => emitted.push(event),
		);

		// Provider/API/model-id equality is insufficient: endpoint B must never
		// receive a replacement issued by endpoint A.
		expect(rewritten).toBeUndefined();
		expect(emitted).toContainEqual(
			expect.objectContaining({ action: "remote_fallback", reason: "remote-replay-origin-mismatch" }),
		);
		expect(rewritten ?? finalPayload).toEqual(finalPayload);
	});

	it("declines replay after the authorization tenant changes without persisting the raw credential", async () => {
		const tenantAKey = "sk-tenant-a-remote-replay-secret";
		const tenantBKey = "sk-tenant-b-remote-replay-secret";
		const currentPrompt = "CURRENT_PROMPT_AFTER_AUTH_TENANT_CHANGE";
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${tenantAKey}`);
			return new Response(
				JSON.stringify({
					id: "resp_tenant_a_checkpoint",
					created_at: 1_775_000_001,
					object: "response.compaction",
					output: [{ type: "compaction", id: "cmp_tenant_a", encrypted_content: "encrypted-checkpoint" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: OPENAI_MODEL.id, contextWindow: 200_000, maxTokens: 16_384 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [(pi) => compactionExtension(pi, { fetch: fetchMock })],
		});

		try {
			await harness.session.bindExtensions({});
			const model = harness.getModel() as Model<"openai-responses">;
			await harness.authStorage.modify(model.provider, async () => ({ type: "api_key", key: tenantAKey }));
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "context compacted for tenant A" }],
				timestamp: 1,
			});
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("tenant A completed this turn"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 2,
			});
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "retain this tenant A turn" }],
				timestamp: 3,
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			await harness.session.compact();

			expect(fetchMock).toHaveBeenCalledOnce();
			const persistedCheckpoint = JSON.stringify(
				harness.sessionManager.getBranch().find((entry) => entry.type === "compaction"),
			);
			expect(persistedCheckpoint).not.toContain(tenantAKey);

			await harness.authStorage.modify(model.provider, async () => ({ type: "api_key", key: tenantBKey }));
			expect(await harness.getExtensionRunner().getModelRegistry().getApiKeyAndHeaders(model)).toMatchObject({
				ok: true,
				apiKey: tenantBKey,
			});
			const finalContext = await harness
				.getExtensionRunner()
				.emitContext([
					...harness.sessionManager.buildSessionContext().messages,
					{ role: "user", content: [{ type: "text", text: currentPrompt }], timestamp: 4 },
				]);
			const finalPayload = {
				model: model.id,
				input: convertResponsesMessages(
					model,
					{ systemPrompt: "current system prompt", messages: convertToLlm(finalContext) },
					new Set(["openai"]),
				),
				stream: true,
			};

			const rewritten = await harness.getExtensionRunner().emitBeforeProviderRequest(finalPayload);

			// A tenant switch cannot replay a checkpoint authorized for tenant A.
			// Persisted provenance may contain a one-way fingerprint, but never the
			// credential itself.
			expect(rewritten).toEqual(finalPayload);
			const outgoingPayload = JSON.stringify(rewritten);
			expect(outgoingPayload.split(currentPrompt)).toHaveLength(2);
			expect(outgoingPayload).not.toContain("encrypted-checkpoint");
		} finally {
			harness.cleanup();
		}
	});

	it("replays a remote checkpoint from the final redacted context without mutating persisted messages", async () => {
		const sensitivePostCompaction = "SENSITIVE_POST_COMPACTION_CONTEXT";
		const sensitiveCurrentPrompt = "SENSITIVE_CURRENT_PROMPT";
		const redactedPostCompaction = "[redacted post-compaction context]";
		const redactedCurrentPrompt = "[redacted current prompt]";
		const contextHookOrder: string[] = [];
		let firstContextHookInput = "";
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [
				{ id: OPENAI_MODEL.id, contextWindow: OPENAI_MODEL.contextWindow, maxTokens: OPENAI_MODEL.maxTokens },
			],
			extensionFactories: [
				compactionExtension,
				(pi) => {
					pi.on("context", (event) => {
						contextHookOrder.push("first");
						firstContextHookInput = JSON.stringify(event.messages);
						return { messages: event.messages };
					});
				},
				(pi) => {
					pi.on("context", (event) => {
						contextHookOrder.push("redact");
						return {
							messages: event.messages.map((message) => {
								if (message.role !== "user" || typeof message.content === "string") return message;
								return {
									...message,
									content: message.content.map((part) =>
										part.type !== "text"
											? part
											: {
													...part,
													text: part.text
														.replaceAll(sensitivePostCompaction, redactedPostCompaction)
														.replaceAll(sensitiveCurrentPrompt, redactedCurrentPrompt),
												},
									),
								};
							}),
						};
					});
				},
			],
		});

		try {
			const model = harness.getModel() as Model<"openai-responses">;
			const headers = createOpenAiRemoteCompactionHeaders(
				model,
				{ apiKey: "faux-key" },
				harness.sessionManager.getSessionId(),
			);
			const origin = headers ? openAiRemoteCompactionOrigin(model, headers) : undefined;
			expect(origin).toBeDefined();
			if (!origin) return;
			const retainedEntryId = harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "retained checkpoint context" }],
				timestamp: 1,
			});
			const checkpoint = buildOpenAiRemoteCompactionResult({
				model,
				firstKeptEntryId: retainedEntryId,
				tokensBefore: 1_234,
				requestInputItemCount: 1,
				response: {
					id: "resp_checkpoint",
					created_at: 1_775_000_001,
					object: "response.compaction",
					output: [{ type: "compaction", id: "cmp_checkpoint", encrypted_content: "encrypted-checkpoint" }],
				},
				origin,
			});
			harness.sessionManager.appendCompaction(
				checkpoint.summary,
				checkpoint.firstKeptEntryId,
				checkpoint.tokensBefore,
				checkpoint.details,
				true,
			);
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `post-checkpoint: ${sensitivePostCompaction}` }],
				timestamp: 2,
			});

			const persistedBeforeTransform = JSON.stringify(harness.sessionManager.getBranch());
			const transformedContext = await harness.getExtensionRunner().emitContext([
				...harness.sessionManager.buildSessionContext().messages,
				{
					role: "user",
					content: [{ type: "text", text: `current prompt: ${sensitiveCurrentPrompt}` }],
					timestamp: 3,
				},
			]);
			const transformedContextText = JSON.stringify(transformedContext);
			expect(contextHookOrder).toEqual(["first", "redact"]);
			expect(firstContextHookInput).toContain(sensitivePostCompaction);
			expect(firstContextHookInput).toContain(sensitiveCurrentPrompt);
			expect(transformedContextText).toContain(redactedPostCompaction);
			expect(transformedContextText).toContain(redactedCurrentPrompt);
			expect(transformedContextText).not.toContain(sensitivePostCompaction);
			expect(transformedContextText).not.toContain(sensitiveCurrentPrompt);
			expect(JSON.stringify(harness.sessionManager.getBranch())).toBe(persistedBeforeTransform);
			expect(persistedBeforeTransform).toContain(sensitivePostCompaction);
			const rewritten = await harness.getExtensionRunner().emitBeforeProviderRequest({
				model: model.id,
				input: convertResponsesMessages(
					model,
					{ systemPrompt: "current system prompt", messages: convertToLlm(transformedContext) },
					new Set(["openai"]),
				),
				stream: true,
			});
			const outgoingRemoteInput = JSON.stringify(rewritten);
			expect(outgoingRemoteInput).toContain("encrypted-checkpoint");
			expect(outgoingRemoteInput).toContain(redactedPostCompaction);
			expect(outgoingRemoteInput).toContain(redactedCurrentPrompt);
			expect(outgoingRemoteInput).not.toContain(sensitivePostCompaction);
			expect(outgoingRemoteInput).not.toContain(sensitiveCurrentPrompt);
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		"x-tenant-id",
		"x-workspace-id",
	] as const)("declines replay when final routing header %s changes for the same endpoint and credential", (routingHeader) => {
		const commonHeaders = {
			authorization: "Bearer shared-account-credential",
			"x-tenant-id": "tenant-a",
			"x-workspace-id": "workspace-a",
		};
		const originA = openAiRemoteCompactionOrigin(OPENAI_MODEL, new Headers(commonHeaders));
		const originB = openAiRemoteCompactionOrigin(
			OPENAI_MODEL,
			new Headers({ ...commonHeaders, [routingHeader]: `${routingHeader}-b` }),
		);
		if (!originA || !originB) throw new Error("Expected remote replay origins");

		const checkpoint = buildOpenAiRemoteCompactionResult({
			model: OPENAI_MODEL,
			firstKeptEntryId: "u2",
			tokensBefore: 1_234,
			requestInputItemCount: 4,
			response: {
				id: `resp_${routingHeader}`,
				created_at: 1_775_000_001,
				object: "response.compaction",
				output: [{ type: "context_compaction", encrypted_content: "routing-bound-checkpoint" }],
			},
			origin: originA,
		});
		const branch: SessionEntry[] = [
			...openAiBranch(),
			{
				type: "compaction",
				id: "routing-checkpoint",
				parentId: "u2",
				timestamp: new Date(1_775_000_002_000).toISOString(),
				summary: checkpoint.summary,
				firstKeptEntryId: checkpoint.firstKeptEntryId,
				tokensBefore: checkpoint.tokensBefore,
				details: checkpoint.details,
				fromHook: true,
			},
		];
		const markedContext = markOpenAiRemoteReplayBoundary(
			[
				...buildSessionContext(branch).messages,
				{ role: "user", content: [{ type: "text", text: "Continue on the new route." }], timestamp: 4 },
			],
			{ model: OPENAI_MODEL, branchEntries: branch },
		);
		const finalPayload = {
			model: OPENAI_MODEL.id,
			input: convertResponsesMessages(OPENAI_MODEL, { messages: convertToLlm(markedContext) }, new Set(["openai"])),
			stream: true,
		};

		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(finalPayload, {
			model: OPENAI_MODEL,
			branchEntries: branch,
			origin: originB,
		});

		// Every final routing decision scopes the native checkpoint, not only
		// credentials. Neither tenant nor workspace state may cross-replay.
		expect(rewritten).toBeUndefined();
		expect(originB.authTenantFingerprint).not.toBe(originA.authTenantFingerprint);
	});

	it("excludes only documented volatile transport headers from non-Codex provenance", () => {
		const stableHeaders = {
			authorization: "Bearer tenant-a",
			"x-tenant-id": "tenant-a",
			accept: "application/json",
		};
		const first = openAiRemoteCompactionOrigin(
			OPENAI_MODEL,
			new Headers({
				...stableHeaders,
				"content-length": "123",
				"user-agent": "senpi test A",
				"x-request-id": "request-a",
				"x-client-request-id": "client-a",
			}),
		);
		const onlyVolatileHeadersChanged = openAiRemoteCompactionOrigin(
			OPENAI_MODEL,
			new Headers({
				...stableHeaders,
				"content-length": "456",
				"user-agent": "senpi test B",
				"x-request-id": "request-b",
				"x-client-request-id": "client-b",
			}),
		);
		const finalNonVolatileHeaderChanged = openAiRemoteCompactionOrigin(
			OPENAI_MODEL,
			new Headers({ ...stableHeaders, accept: "application/vnd.route-b+json" }),
		);

		expect(first).toBeDefined();
		expect(onlyVolatileHeadersChanged).toEqual(first);
		expect(finalNonVolatileHeaderChanged?.authTenantFingerprint).not.toBe(first?.authTenantFingerprint);
	});
});
