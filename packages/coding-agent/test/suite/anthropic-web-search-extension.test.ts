import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicWebSearchExtension, {
	ANTHROPIC_WEB_SEARCH_SECTION,
	addAnthropicWebSearchToPayload,
	isAnthropicWebSearchEnabled,
} from "../../src/core/extensions/builtin/anthropic-web-search/index.js";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";

const ENABLE_ENV = "PI_ANTHROPIC_WEB_SEARCH";
const ALLOWED_DOMAINS_ENV = "PI_ANTHROPIC_WEB_SEARCH_ALLOWED_DOMAINS";
const BLOCKED_DOMAINS_ENV = "PI_ANTHROPIC_WEB_SEARCH_BLOCKED_DOMAINS";

type TestUi = {
	setStatus: (key: string, value: string | undefined) => void;
	setWidget: (key: string, lines: string[] | undefined, options?: { placement: "belowEditor" }) => void;
	theme: { fg: (key: string, value: string) => string };
};

afterEach(() => {
	delete process.env[ENABLE_ENV];
	delete process.env[ALLOWED_DOMAINS_ENV];
	delete process.env[BLOCKED_DOMAINS_ENV];
});

describe("anthropic-web-search builtin extension", () => {
	it("is a no-op when model api is not anthropic-messages", () => {
		const payload = {
			tools: [{ name: "web_search", description: "function tool" }],
		};

		const result = addAnthropicWebSearchToPayload("openai-responses", payload);

		expect(result).toBe(payload);
	});

	it("injects the native Anthropic web_search tool with default max_uses", () => {
		const payload = {
			model: "claude-sonnet-4-5",
			tools: [{ name: "other_tool" }],
		};

		const result = addAnthropicWebSearchToPayload("anthropic-messages", payload) as {
			tools: unknown[];
		};

		expect(result.tools).toContainEqual({
			type: "web_search_20250305",
			name: "web_search",
			max_uses: 8,
		});
	});

	it("preserves caller-supplied native web_search version without duplication", () => {
		const payload = {
			tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
		};

		const result = addAnthropicWebSearchToPayload("anthropic-messages", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		const webSearchTools = result.tools.filter((tool) => tool.name === "web_search");
		expect(webSearchTools).toHaveLength(1);
		expect(webSearchTools[0]).toEqual({ type: "web_search_20260209", name: "web_search", max_uses: 3 });
	});

	it("replaces function-tool web_search with Anthropic native tool", () => {
		const payload = {
			tools: [{ name: "web_search", description: "pi-websearch function" }, { name: "other_tool" }],
		};

		const result = addAnthropicWebSearchToPayload("anthropic-messages", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		const webSearchTools = result.tools.filter((tool) => tool.name === "web_search");
		expect(webSearchTools).toHaveLength(1);
		expect(webSearchTools[0]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 8 });
	});

	it("does not strip function-tool web_search when api is non-anthropic", () => {
		const payload = {
			tools: [{ name: "web_search", description: "pi-websearch function" }],
		};

		const result = addAnthropicWebSearchToPayload("openai-completions", payload);

		expect(result).toBe(payload);
	});

	it("adds configured domain filters to the injected web_search tool", () => {
		process.env[ALLOWED_DOMAINS_ENV] = "docs.anthropic.com, example.com";
		process.env[BLOCKED_DOMAINS_ENV] = "spam.example, ads.example";
		const payload = {
			tools: [{ name: "other_tool" }],
		};

		const result = addAnthropicWebSearchToPayload("anthropic-messages", payload) as {
			tools: unknown[];
		};

		expect(result.tools).toContainEqual({
			type: "web_search_20250305",
			name: "web_search",
			allowed_domains: ["docs.anthropic.com", "example.com"],
			blocked_domains: ["spam.example", "ads.example"],
			max_uses: 8,
		});
	});

	it("returns original payload reference when explicitly disabled", () => {
		process.env[ENABLE_ENV] = "0";
		const payload = {
			tools: [{ name: "web_search", description: "function tool" }],
		};

		const result = addAnthropicWebSearchToPayload("anthropic-messages", payload);

		expect(result).toBe(payload);
	});

	it("still behaves as default-on when enable env is unset", () => {
		const payload = {
			tools: [{ name: "other_tool" }],
		};

		const result = addAnthropicWebSearchToPayload("anthropic-messages", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toContainEqual({
			type: "web_search_20250305",
			name: "web_search",
			max_uses: 8,
		});
	});
});

describe("isAnthropicWebSearchEnabled", () => {
	it("returns true when env is unset", () => {
		expect(isAnthropicWebSearchEnabled()).toBe(true);
	});

	it.each(["1", "true", "yes", "on", "TRUE", "YES", "  on  "])("returns true for truthy value %s", (value) => {
		process.env[ENABLE_ENV] = value;
		expect(isAnthropicWebSearchEnabled()).toBe(true);
	});

	it.each(["0", "false", "no", "off", "OFF", "  no  "])("returns false for falsy value %s", (value) => {
		process.env[ENABLE_ENV] = value;
		expect(isAnthropicWebSearchEnabled()).toBe(false);
	});

	it.each(["garbage", "enable", "enabled"])("returns true for unknown value %s", (value) => {
		process.env[ENABLE_ENV] = value;
		expect(isAnthropicWebSearchEnabled()).toBe(true);
	});
});

describe("anthropic-web-search before_agent_start", () => {
	it("shows native web search widget for Anthropic sessions", async () => {
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

		anthropicWebSearchExtension(pi as ExtensionAPI);
		await sessionStartHandler?.(
			{},
			{
				model: { api: "anthropic-messages" },
				hasUI: true,
				ui: { setStatus, setWidget, theme: { fg: (_key: string, value: string) => value } },
			},
		);

		expect(setStatus).toHaveBeenCalledWith("anthropic-web-search", "web_search native");
		expect(setWidget).toHaveBeenCalledWith(
			"anthropic-web-search",
			["Native Web Search", "Anthropic · web_search_20250305 · max_uses 8"],
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

		anthropicWebSearchExtension(pi as ExtensionAPI);
		expect(beforeAgentStartHandler).toBeDefined();

		const result = await beforeAgentStartHandler?.(
			{ systemPrompt: "system" },
			{ model: { api: "anthropic-messages" } },
		);

		expect(result).toBeUndefined();
	});
});

describe("ANTHROPIC_WEB_SEARCH_SECTION content", () => {
	it("mentions web_search availability", () => {
		expect(ANTHROPIC_WEB_SEARCH_SECTION).toContain("web_search");
	});
});
