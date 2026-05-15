import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CompactionResult, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.js";
import { createEventBus } from "../../src/core/event-bus.js";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.js";
import type { BeforeAgentStartEvent } from "../../src/core/extensions/index.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.js";
import type { SessionEntry, SessionMessageEntry } from "../../src/core/session-manager.js";

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
		});
	});
});
