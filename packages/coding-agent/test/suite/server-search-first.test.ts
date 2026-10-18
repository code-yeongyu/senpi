import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAnthropicWebSearchToPayload } from "../../src/core/extensions/builtin/anthropic-web-search/index.ts";
import { addOpenAiWebSearchToPayload } from "../../src/core/extensions/builtin/openai-web-search/index.ts";
import {
	hasServerSearchFailed,
	markServerSearchFallback,
} from "../../src/core/extensions/builtin/server-search-fallback.ts";
import websearchExtension from "../../src/core/extensions/builtin/websearch/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

const model = {
	provider: "anthropic",
	id: "claude-opus-5-5",
	api: "anthropic-messages",
	baseUrl: "https://proxy.example.com/anthropic",
	compat: { supportsWebSearch: true },
} as const;
const responseIdentity = { api: model.api, provider: model.provider, model: model.id };

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type SearchTool = {
	execute(
		id: string,
		args: { query: string },
		signal: undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

function harness(cwd: string) {
	const handlers = new Map<string, Handler>();
	let tool: SearchTool | undefined;
	const sendMessage = vi.fn();
	const appendEntry = vi.fn();
	websearchExtension({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (value: SearchTool) => {
			if ("name" in value && value.name === "web_search") tool = value;
		},
		registerCommand: () => {},
		getActiveTools: () => ["web_search"],
		setActiveTools: () => {},
		sendMessage,
		appendEntry,
	} as unknown as ExtensionAPI);
	const ctx = { cwd, model, hasUI: false, sessionManager: {} } as unknown as ExtensionContext;
	return {
		sendMessage,
		appendEntry,
		ctx,
		emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
		execute: async () => {
			if (!tool) throw new Error("Tool missing");
			return tool.execute("search", { query: "official documentation" }, undefined, undefined, ctx);
		},
		payload: async () => {
			const initial = {
				model: model.id,
				messages: [{ role: "user", content: "Find the official documentation." }],
				tools: [{ name: "web_search", input_schema: { type: "object" } }],
			};
			const native = addAnthropicWebSearchToPayload(
				model,
				hasServerSearchFailed(ctx.sessionManager, ctx.model) ? markServerSearchFallback(initial) : initial,
			);
			return (await handlers.get("before_provider_request")?.({ model, payload: native }, ctx)) as {
				tools: Array<{ name: string; type?: string; input_schema?: unknown }>;
			};
		},
	};
}

describe("server search first (#3122)", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "server-search-first-"));
		await mkdir(join(cwd, ".pi"));
		await writeFile(
			join(cwd, ".pi", "websearch.json"),
			JSON.stringify({ auto: false, providers: [{ provider: "exa", apiKey: "test-key" }] }),
		);
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		await rm(cwd, { recursive: true, force: true });
	});

	it("sends an eligible proxy's server tool in the main request without a standalone request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const h = harness(cwd);
		await h.emit("session_start");
		const payload = await h.payload();
		expect(payload.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]);
		await h.execute();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("restores standalone search after a server-tool rejection, logs one reason and continues once", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ results: [{ title: "Official docs", url: "https://example.com/docs", text: "Docs" }] }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const h = harness(cwd);
		await h.emit("session_start");
		const failure = {
			message: {
				role: "assistant",
				...responseIdentity,
				content: [],
				stopReason: "error",
				errorMessage: "HTTP 400: web_search_20250305 unsupported",
			},
		};
		await h.emit("message_end", failure);
		await h.emit("message_end", failure);
		await h.emit("agent_end", { willRetry: false });
		await h.emit("agent_settled");
		await h.emit("agent_settled");
		expect(h.appendEntry).toHaveBeenCalledTimes(1);
		expect(h.appendEntry).toHaveBeenCalledWith("websearch-native-fallback", {
			reason: "server search request rejected (HTTP 400)",
		});
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
		await h.emit("before_agent_start", { trigger: "extension", systemPrompt: "" });
		const retry = await h.payload();
		expect(retry.tools).toHaveLength(1);
		expect(retry.tools[0]?.type).toBeUndefined();
		expect(retry.tools[0]?.input_schema).toBeDefined();
		expect((await h.execute()).content[0]?.text).toContain("https://example.com/docs");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not schedule a duplicate continuation when core retry already owns the request", async () => {
		const h = harness(cwd);
		await h.emit("session_start");
		await h.emit("message_end", {
			message: {
				role: "assistant",
				...responseIdentity,
				content: [],
				stopReason: "error",
				errorMessage: "503 web_search_20250305 unavailable",
			},
		});
		await h.emit("agent_end", { willRetry: true });
		await h.emit("agent_settled");
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect((await h.payload()).tools[0]?.type).toBeUndefined();
	});

	it("does not interpret cancellation or unrelated provider errors as search failures", async () => {
		const h = harness(cwd);
		await h.emit("session_start");
		for (const message of [
			{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "web_search aborted" },
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid credentials" },
		]) {
			await h.emit("message_end", {
				message: { ...message, api: model.api, provider: model.provider, model: model.id },
			});
		}
		await h.emit("agent_settled");
		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("remembers a native failure for later user prompts in the same session model", async () => {
		const h = harness(cwd);
		await h.emit("session_start");
		await h.emit("message_end", {
			message: {
				role: "assistant",
				...responseIdentity,
				content: [],
				stopReason: "error",
				errorMessage: "400 web_search_20250305 rejected",
			},
		});
		await h.emit("before_agent_start", { trigger: "prompt", systemPrompt: "" });
		expect((await h.payload()).tools[0]?.type).toBeUndefined();
		expect((await h.payload()).tools[0]?.input_schema).toEqual({ type: "object" });
	});

	it("does not duplicate a completed answer after the provider recovered from a search-result error", async () => {
		const h = harness(cwd);
		await h.emit("session_start");
		await h.emit("message_end", {
			message: {
				role: "assistant",
				...responseIdentity,
				stopReason: "stop",
				content: [
					{
						type: "providerNative",
						subtype: "web_search_tool_result",
						raw: {
							type: "web_search_tool_result",
							content: { type: "web_search_tool_result_error", error_code: "unavailable" },
						},
					},
					{ type: "text", text: "Here is the completed answer from the other available sources." },
				],
			},
		});
		await h.emit("agent_settled");
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.appendEntry).toHaveBeenCalledTimes(1);
		expect((await h.payload()).tools[0]?.type).toBeUndefined();
	});

	it("drops a pending fallback continuation after the user aborts", async () => {
		const h = harness(cwd);
		await h.emit("session_start");
		await h.emit("message_end", {
			message: {
				role: "assistant",
				...responseIdentity,
				content: [],
				stopReason: "error",
				errorMessage: "400 web_search_20250305 unsupported",
			},
		});
		await h.emit("session_abort");
		await h.emit("agent_settled");
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("keeps failed-turn fallback state intact during a prompt-cache preview", async () => {
		const h = harness(cwd);
		await h.emit("session_start");
		await h.emit("message_end", {
			message: {
				role: "assistant",
				...responseIdentity,
				content: [],
				stopReason: "error",
				errorMessage: "400 web_search_20250305 unsupported",
			},
		});

		await h.emit("before_agent_start", { preview: true, trigger: "prompt", systemPrompt: "" });

		expect((await h.payload()).tools[0]?.type).toBeUndefined();
		await h.emit("agent_settled");
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("uses the subscription's in-turn web_search tool instead of the auxiliary search model", () => {
		const payload = addOpenAiWebSearchToPayload(
			{ api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
			{ tools: [{ type: "function", name: "web_search", parameters: {} }] },
		) as { tools: unknown[] };
		expect(payload.tools).toEqual([{ type: "web_search" }]);
	});
});
