import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import websearchExtension from "../../src/core/extensions/builtin/websearch/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

const ANTHROPIC_ENABLE_ENV = "PI_ANTHROPIC_WEB_SEARCH";
const OPENAI_ENABLE_ENV = "PI_OPENAI_WEB_SEARCH";
const NATIVE_BYPASS_MESSAGE = "Native provider web search is handled by the built-in provider extension.";

interface RegisteredTool {
	execute(
		toolCallId: string,
		params: { query: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx?: unknown,
	): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface Harness {
	tool: RegisteredTool;
	sessionStart(model: unknown): Promise<void>;
	modelSelect(model: unknown): Promise<void>;
}

function createHarness(cwd: string): Harness {
	const handlers = new Map<string, EventHandler>();
	let tool: RegisteredTool | undefined;
	const pi = {
		registerTool(definition: unknown) {
			tool = definition as RegisteredTool;
		},
		registerCommand() {},
		on(eventName: string, handler: unknown) {
			handlers.set(eventName, handler as EventHandler);
		},
	};
	websearchExtension(pi as unknown as ExtensionAPI);
	if (!tool) throw new Error("websearch extension did not register a tool");

	function contextFor(model: unknown): ExtensionContext {
		return { model, cwd, hasUI: false } as unknown as ExtensionContext;
	}

	return {
		tool,
		async sessionStart(model: unknown) {
			await handlers.get("session_start")?.({ type: "session_start" }, contextFor(model));
		},
		async modelSelect(model: unknown) {
			await handlers.get("model_select")?.({ type: "model_select", model }, contextFor(model));
		},
	};
}

function exaResponse(): Response {
	return new Response(
		JSON.stringify({
			results: [{ title: "Result", url: "https://example.com/hit", text: "snippet" }],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

const firstPartyAnthropic = {
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
};

const proxiedAnthropic = {
	provider: "anthropic",
	id: "claude-fable-5",
	api: "anthropic-messages",
	baseUrl: "https://ccapi.example.com/anthropic",
};

const firstPartyOpenAi = {
	provider: "openai",
	id: "gpt-5.5",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
};

const proxiedOpenAi = {
	provider: "openai",
	id: "gpt-5.5",
	api: "openai-responses",
	baseUrl: "https://quotio.example.com/v1",
};

describe("websearch extension native bypass gating", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "websearch-bypass-"));
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "websearch.json"),
			JSON.stringify({ auto: false, providers: [{ id: "cfg", provider: "exa", apiKey: "test-key" }] }),
		);
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		delete process.env[ANTHROPIC_ENABLE_ENV];
		delete process.env[OPENAI_ENABLE_ENV];
		await rm(cwd, { recursive: true, force: true });
	});

	it("#given an anthropic model on a proxied baseUrl #when the session starts #then web_search stays active instead of hard-failing", async () => {
		// given
		const fetchMock = vi.fn<typeof fetch>(async () => exaResponse());
		vi.stubGlobal("fetch", fetchMock);
		const harness = createHarness(cwd);
		await harness.sessionStart(proxiedAnthropic);

		// when
		const result = await harness.tool.execute(
			"proxied-anthropic",
			{ query: "three.js release" },
			undefined,
			undefined,
		);

		// then
		const text = result.content[0]?.text ?? "";
		expect(text).not.toContain(NATIVE_BYPASS_MESSAGE);
		expect(text).toContain("three.js release");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("#given a first-party anthropic model #when the session starts #then web_search defers to the provider-native tool", async () => {
		// given
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const harness = createHarness(cwd);
		await harness.sessionStart(firstPartyAnthropic);

		// when
		const result = await harness.tool.execute("first-party-anthropic", { query: "anything" }, undefined, undefined);

		// then
		expect(result.content[0]?.text).toContain(NATIVE_BYPASS_MESSAGE);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("#given native anthropic web search disabled by env #when the session starts #then standalone web_search activates", async () => {
		// given
		process.env[ANTHROPIC_ENABLE_ENV] = "0";
		const fetchMock = vi.fn<typeof fetch>(async () => exaResponse());
		vi.stubGlobal("fetch", fetchMock);
		const harness = createHarness(cwd);
		await harness.sessionStart(firstPartyAnthropic);

		// when
		const result = await harness.tool.execute("env-disabled", { query: "current news" }, undefined, undefined);

		// then
		expect(result.content[0]?.text).not.toContain(NATIVE_BYPASS_MESSAGE);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("#given a session started on a first-party model #when switching to a proxied model #then web_search reactivates", async () => {
		// given
		const fetchMock = vi.fn<typeof fetch>(async () => exaResponse());
		vi.stubGlobal("fetch", fetchMock);
		const harness = createHarness(cwd);
		await harness.sessionStart(firstPartyAnthropic);

		// when
		await harness.modelSelect(proxiedAnthropic);
		const result = await harness.tool.execute("after-switch", { query: "switched" }, undefined, undefined);

		// then
		expect(result.content[0]?.text).not.toContain(NATIVE_BYPASS_MESSAGE);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("#given a session started on a proxied model #when switching to a first-party model #then web_search defers again", async () => {
		// given
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const harness = createHarness(cwd);
		await harness.sessionStart(proxiedAnthropic);

		// when
		await harness.modelSelect(firstPartyAnthropic);
		const result = await harness.tool.execute("switch-to-native", { query: "anything" }, undefined, undefined);

		// then
		expect(result.content[0]?.text).toContain(NATIVE_BYPASS_MESSAGE);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("#given an openai model on a proxied baseUrl #when the session starts #then web_search stays active", async () => {
		// given
		const fetchMock = vi.fn<typeof fetch>(async () => exaResponse());
		vi.stubGlobal("fetch", fetchMock);
		const harness = createHarness(cwd);
		await harness.sessionStart(proxiedOpenAi);

		// when
		const result = await harness.tool.execute("proxied-openai", { query: "proxied openai" }, undefined, undefined);

		// then
		expect(result.content[0]?.text).not.toContain(NATIVE_BYPASS_MESSAGE);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("#given a first-party openai model #when the session starts #then web_search defers to the provider-native tool", async () => {
		// given
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const harness = createHarness(cwd);
		await harness.sessionStart(firstPartyOpenAi);

		// when
		const result = await harness.tool.execute("first-party-openai", { query: "anything" }, undefined, undefined);

		// then
		expect(result.content[0]?.text).toContain(NATIVE_BYPASS_MESSAGE);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
