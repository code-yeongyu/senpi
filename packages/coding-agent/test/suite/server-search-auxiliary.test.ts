import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Api,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { completeSummarization } from "../../src/core/compaction/compaction.ts";
import anthropicWebSearchExtension, {
	addAnthropicWebSearchToPayload,
} from "../../src/core/extensions/builtin/anthropic-web-search/index.ts";
import openaiWebSearchExtension, {
	addOpenAiWebSearchToPayload,
} from "../../src/core/extensions/builtin/openai-web-search/index.ts";
import websearchExtension from "../../src/core/extensions/builtin/websearch/index.ts";
import { serverSearchPayload } from "../../src/core/extensions/builtin/websearch/server-search.ts";
import { generateSessionTitle } from "../../src/core/session-title-generator.ts";
import { createHarness } from "./harness.ts";

const routes = [
	["anthropic-messages", "anthropic", "claude-opus-5-5"],
	["openai-responses", "openai", "gpt-6-luna"],
	["openai-codex-responses", "openai-codex", "gpt-5.5"],
	["google-generative-ai", "google", "gemini-2.5-pro"],
	["google-vertex", "google-vertex", "gemini-3-pro-preview"],
	["openai-completions", "openrouter", "anthropic/claude-opus-5"],
	["openai-completions", "moonshotai", "kimi-k3"],
] as const;

function route(api: Api, provider: string, id: string): Model<Api> {
	return {
		api,
		provider,
		id,
		name: id,
		baseUrl: api === "openai-codex-responses" ? "https://chatgpt.com/backend-api" : "https://example.com",
		compat: { supportsWebSearch: true, supportsWebSearchPreview: true },
		reasoning: false,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("auxiliary server search policy", () => {
	it.each(routes)(
		"does not inject server search into title or summary requests on %s/%s",
		async (api, provider, id) => {
			const model = route(api, provider, id);
			const onPayload = (payload: unknown) =>
				serverSearchPayload(
					model,
					addOpenAiWebSearchToPayload(model, addAnthropicWebSearchToPayload(model, payload)),
				);
			const raw = api.startsWith("google") ? { config: { tools: [] } } : { tools: [] };
			expect(JSON.stringify(onPayload(raw))).toMatch(/web_search|googleSearch/);
			const captured: unknown[] = [];
			const streamFn: StreamFn = async (_model, _context, options) => {
				captured.push(await options?.onPayload?.(raw, model));
				const message = fauxAssistantMessage("<title>Search Exclusion Works</title>");
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			await generateSessionTitle({
				firstPrompt: "Fix the parser",
				model,
				auth: {},
				sessionId: "title-search-policy",
				baseOptions: { onPayload },
				streamFn,
			});
			await completeSummarization(
				model,
				normalizeContext({ systemPrompt: "Summarize", messages: [] }),
				{ onPayload },
				streamFn,
			);
			expect(captured).toHaveLength(2);
			for (const payload of captured)
				expect(JSON.stringify(payload)).not.toMatch(/web_search|googleSearch|google_search/);
			// Suppression is request-local; the next normal request still has search.
			expect(JSON.stringify(onPayload(raw))).toMatch(/web_search|googleSearch/);
		},
	);

	it("disables search in compaction projections but preserves the explicit keepalive prefix", async () => {
		const h = await createHarness({
			api: "anthropic-messages",
			extensionFactories: [anthropicWebSearchExtension, websearchExtension],
		});
		try {
			h.agent.state.model = { ...h.agent.state.model, compat: { supportsWebSearch: true } } as Model<Api>;
			const runner = h.getExtensionRunner();
			await runner.emit({ type: "session_start", reason: "startup" });
			const auxiliary = await runner.prepareProviderRequest([]);
			expect(JSON.stringify(await auxiliary.transformPayload({ tools: [] }))).not.toContain("web_search");
			const keepalive = await runner.prepareProviderRequest([], undefined, { allowServerSearch: true });
			expect(JSON.stringify(await keepalive.transformPayload({ tools: [] }))).toContain("web_search_20250305");
		} finally {
			h.cleanup();
		}
	});

	it.each(["anthropic-messages", "openai-codex-responses"] as const)(
		"preserves the main-turn hook and byte-identical tools/include for cache-friendly %s summaries",
		async (api) => {
			// senpi#3125: retain the original hook and warm prefix on source-context compaction.
			const h = await createHarness({
				api,
				extensionFactories: [anthropicWebSearchExtension, openaiWebSearchExtension, websearchExtension],
			});
			try {
				const model = route(
					api,
					api === "anthropic-messages" ? "anthropic" : "openai-codex",
					api === "anthropic-messages" ? "claude-opus-5-5" : "gpt-5.5",
				);
				h.agent.state.model = model;
				const runner = h.getExtensionRunner();
				await runner.emit({ type: "session_start", reason: "startup" });
				const onPayload = async (payload: unknown) =>
					runner.emitBeforeProviderRequest(payload, undefined, { model, headers: {} });
				const raw = { tools: [{ name: "read", input_schema: {} }] };
				const main = await onPayload(raw);
				let summary: unknown;
				const streamFn: StreamFn = async (_model, _context, options) => {
					summary = await options?.onPayload?.(raw, model);
					const message = fauxAssistantMessage("Summary");
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				};
				await completeSummarization(
					model,
					normalizeContext({ messages: [] }),
					{ onPayload, cacheRetention: "short" },
					streamFn,
				);
				expect(JSON.stringify(main)).toMatch(/web_search/);
				expect(JSON.stringify(summary)).toBe(JSON.stringify(main));
			} finally {
				h.cleanup();
			}
		},
	);
});
