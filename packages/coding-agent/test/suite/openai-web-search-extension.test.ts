import { afterEach, describe, expect, it, vi } from "vitest";
import openaiWebSearchExtension, {
	addOpenAiWebSearchToPayload,
	isOpenaiWebSearchEnabled,
} from "../../src/core/extensions/builtin/openai-web-search/index.js";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";

const ENABLE_ENV = "PI_OPENAI_WEB_SEARCH";

type TestUi = {
	setStatus: (key: string, value: string | undefined) => void;
	setWidget: (key: string, lines: string[] | undefined, options?: { placement: "belowEditor" }) => void;
	theme: { fg: (key: string, value: string) => string };
};

afterEach(() => {
	delete process.env[ENABLE_ENV];
});

describe("openai-web-search builtin extension", () => {
	it("is a no-op when model api is openai-completions", () => {
		const payload = {
			tools: [{ name: "web_search", description: "function tool" }],
		};

		const result = addOpenAiWebSearchToPayload("openai-completions", payload);

		expect(result).toBe(payload);
	});

	it("is a no-op when model api is anthropic-messages", () => {
		const payload = {
			tools: [{ name: "web_search", description: "function tool" }],
		};

		const result = addOpenAiWebSearchToPayload("anthropic-messages", payload);

		expect(result).toBe(payload);
	});

	it("injects native web_search when on openai-responses and none exists", () => {
		const payload = {
			tools: [{ name: "other_tool" }],
		};

		const result = addOpenAiWebSearchToPayload("openai-responses", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toContainEqual({ type: "web_search_preview" });
	});

	it("injects native web_search when on azure-openai-responses and none exists", () => {
		const payload = {
			tools: [{ name: "other_tool" }],
		};

		const result = addOpenAiWebSearchToPayload("azure-openai-responses", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toContainEqual({ type: "web_search_preview" });
	});

	it("preserves caller-supplied web_search_preview and does not duplicate", () => {
		const payload = {
			tools: [{ type: "web_search_preview" }, { name: "other_tool" }],
		};

		const result = addOpenAiWebSearchToPayload("openai-responses", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		const webSearchTools = result.tools.filter(
			(tool) => tool.type === "web_search_preview" || tool.type === "web_search_preview_2025_03_11",
		);
		expect(webSearchTools).toHaveLength(1);
		expect(webSearchTools[0]).toEqual({ type: "web_search_preview" });
	});

	it("strips function-tool web_search and replaces it with native on openai-responses", () => {
		const payload = {
			tools: [{ name: "web_search", description: "pi-websearch function" }, { name: "other_tool" }],
		};

		const result = addOpenAiWebSearchToPayload("openai-responses", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).not.toContainEqual({ name: "web_search", description: "pi-websearch function" });
		expect(result.tools).toContainEqual({ type: "web_search_preview" });
	});

	it("strips Anthropic native web tool definitions before sending OpenAI Responses payloads", () => {
		const payload = {
			tools: [
				{ type: "function", name: "other_tool" },
				{ type: "web_search_20250305", name: "web_search", max_uses: 5 },
				{ type: "web_fetch_20260309", name: "web_fetch", max_uses: 5 },
			],
		};

		const result = addOpenAiWebSearchToPayload("openai-responses", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toEqual([{ type: "function", name: "other_tool" }, { type: "web_search_preview" }]);
	});

	it("preserves Pi webfetch function tools while stripping Anthropic native web_fetch", () => {
		const payload = {
			tools: [
				{ name: "webfetch", description: "Pi webfetch function tool" },
				{ type: "web_fetch_20260309", name: "web_fetch", max_uses: 5 },
			],
		};

		const result = addOpenAiWebSearchToPayload("openai-responses", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toEqual([
			{ name: "webfetch", description: "Pi webfetch function tool" },
			{ type: "web_search_preview" },
		]);
	});

	it("still strips Anthropic native web tool definitions when OpenAI web search injection is disabled", () => {
		process.env[ENABLE_ENV] = "off";
		const payload = {
			tools: [
				{ type: "function", name: "other_tool" },
				{ type: "web_search_20250305", name: "web_search", max_uses: 5 },
				{ type: "web_fetch_20260309", name: "web_fetch", max_uses: 5 },
			],
		};

		const result = addOpenAiWebSearchToPayload("openai-responses", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toEqual([{ type: "function", name: "other_tool" }]);
	});

	it("does not strip function-tool web_search when api is not Responses", () => {
		const payload = {
			tools: [{ name: "web_search", description: "pi-websearch function" }],
		};

		const result = addOpenAiWebSearchToPayload("openai-completions", payload);

		expect(result).toBe(payload);
	});

	it("returns original payload reference when explicitly disabled", () => {
		process.env[ENABLE_ENV] = "0";
		const payload = {
			tools: [{ name: "web_search", description: "function tool" }],
		};

		const result = addOpenAiWebSearchToPayload("openai-responses", payload);

		expect(result).toBe(payload);
	});

	it("still behaves as default-on when enable env is unset", () => {
		const payload = {
			tools: [{ name: "other_tool" }],
		};

		const result = addOpenAiWebSearchToPayload("openai-responses", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toContainEqual({ type: "web_search_preview" });
	});
});

describe("isOpenaiWebSearchEnabled", () => {
	it("returns true when env is unset", () => {
		expect(isOpenaiWebSearchEnabled()).toBe(true);
	});

	it.each(["1", "true", "yes", "on", "TRUE", "YES", "  on  "])("returns true for truthy value %s", (value) => {
		process.env[ENABLE_ENV] = value;
		expect(isOpenaiWebSearchEnabled()).toBe(true);
	});

	it.each(["0", "false", "no", "off", "OFF", "  no  "])("returns false for falsy value %s", (value) => {
		process.env[ENABLE_ENV] = value;
		expect(isOpenaiWebSearchEnabled()).toBe(false);
	});

	it.each(["garbage", "enable", "enabled"])("returns true for unknown value %s", (value) => {
		process.env[ENABLE_ENV] = value;
		expect(isOpenaiWebSearchEnabled()).toBe(true);
	});
});

describe("openai-web-search before_agent_start", () => {
	it("shows native web search widget for OpenAI Responses sessions", async () => {
		type SessionStartHandler = (
			event: object,
			ctx: { model?: { api?: string }; hasUI?: boolean; ui: TestUi },
		) => Promise<void> | void;

		let sessionStartHandler: SessionStartHandler | undefined;
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const pi = {
			on(eventName: string, handler: unknown) {
				if (eventName === "session_start") {
					sessionStartHandler = handler as SessionStartHandler;
				}
			},
		} satisfies Pick<ExtensionAPI, "on">;

		openaiWebSearchExtension(pi as ExtensionAPI);
		await sessionStartHandler?.(
			{},
			{
				model: { api: "openai-responses" },
				hasUI: true,
				ui: { setStatus, setWidget, theme: { fg: (_key: string, value: string) => value } },
			},
		);

		expect(setStatus).toHaveBeenCalledWith("openai-web-search", "web_search native");
		expect(setWidget).toHaveBeenCalledWith(
			"openai-web-search",
			["Native Web Search", "OpenAI Responses · web_search_preview"],
			{ placement: "belowEditor" },
		);
	});

	it("does not append system prompt when explicitly disabled", async () => {
		process.env[ENABLE_ENV] = "off";

		type BeforeAgentStartHandler = (
			event: { systemPrompt: string },
			ctx: { model?: { api?: string } },
		) => Promise<{ systemPrompt: string } | undefined>;

		let beforeAgentStartHandler: BeforeAgentStartHandler | undefined;
		const pi = {
			on(eventName: string, handler: unknown) {
				if (eventName === "before_agent_start") {
					beforeAgentStartHandler = handler as BeforeAgentStartHandler;
				}
			},
		} satisfies Pick<ExtensionAPI, "on">;

		openaiWebSearchExtension(pi as ExtensionAPI);
		expect(beforeAgentStartHandler).toBeDefined();

		const result = await beforeAgentStartHandler?.(
			{ systemPrompt: "system" },
			{ model: { api: "openai-responses" } },
		);

		expect(result).toBeUndefined();
	});
});
