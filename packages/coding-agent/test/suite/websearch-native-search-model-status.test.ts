import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import websearchExtension from "../../src/core/extensions/builtin/websearch/index.ts";
import { loadWebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import type { createWebSearchTool } from "../../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type { ExtensionAPI, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import {
	anthropicSearchResponse,
	captureFetch,
	otherProviderLuna,
	proxyHaiku,
	registryWith,
	sessionOpus,
	toolContext,
} from "./websearch-native-search-model-fixtures.ts";

// senpi#2340: the nativeModel setting in websearch.json and what /websearch status reports about it.

describe("websearch nativeModel config and status (senpi#2340)", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "websearch-native-model-"));
		await mkdir(join(cwd, ".pi"), { recursive: true });
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await rm(cwd, { recursive: true, force: true });
	});

	async function writeConfig(value: unknown): Promise<void> {
		await writeFile(join(cwd, ".pi", "websearch.json"), JSON.stringify(value));
	}

	it("#given a top-level nativeModel #when loading websearch.json #then the config carries it", async () => {
		// given
		await writeConfig({ nativeModel: "claude-haiku-4-5", providers: [{ provider: "duckduckgo-html" }] });

		// when
		const loaded = await loadWebsearchConfig({ cwd, homeDir: cwd });

		// then
		expect(loaded.ok && loaded.config.nativeModel).toBe("claude-haiku-4-5");
	});

	it("#given a non-string nativeModel #when loading websearch.json #then the config is rejected with a named reason", async () => {
		// given
		await writeConfig({ nativeModel: 42, providers: [{ provider: "duckduckgo-html" }] });

		// when
		const loaded = await loadWebsearchConfig({ cwd, homeDir: cwd });

		// then
		expect(loaded.ok).toBe(false);
		expect(loaded.ok ? "" : loaded.message).toContain("nativeModel");
	});

	type CommandHandler = (rawArgs: string, ctx: unknown) => Promise<void>;
	type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
	type RegisteredTool = ReturnType<typeof createWebSearchTool>;

	function loadExtension(): { sessionStart: Handler; status: CommandHandler; tool: RegisteredTool } {
		let sessionStart: Handler | undefined;
		let status: CommandHandler | undefined;
		let tool: RegisteredTool | undefined;
		websearchExtension({
			registerTool(definition: RegisteredTool) {
				tool = definition;
			},
			registerCommand(_name: string, definition: { handler: CommandHandler }) {
				status = definition.handler;
			},
			on(eventName: string, handler: Handler) {
				if (eventName === "session_start") sessionStart = handler;
			},
		} as unknown as ExtensionAPI);
		if (!sessionStart || !status || !tool) throw new Error("websearch extension did not register its surfaces");
		return { sessionStart, status, tool };
	}

	it("#given nativeModel names another provider's model #when /websearch status runs #then it warns that the setting is ignored", async () => {
		// given
		await writeConfig({ nativeModel: "gpt-5.6-luna", providers: [{ provider: "duckduckgo-html" }] });
		const registry = registryWith([sessionOpus, proxyHaiku, otherProviderLuna]);
		const { sessionStart, status } = loadExtension();
		const ui = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() };
		await sessionStart(
			{ type: "session_start" },
			{ cwd, model: sessionOpus, modelRegistry: registry, hasUI: false, ui },
		);
		const notify = vi.fn();

		// when
		await status("status", { ui: { notify }, model: sessionOpus, modelRegistry: registry });

		// then
		expect(notify).toHaveBeenCalledTimes(1);
		const [message, level] = notify.mock.calls[0] ?? [];
		expect(level).toBe("warning");
		expect(message).toContain('nativeModel "gpt-5.6-luna" is ignored');
		expect(message).toContain("native model=claude-opus-4-5");
	});

	it("#given a search served by the chosen model #when /websearch status runs #then it names the planned and the serving model", async () => {
		// given
		await writeConfig({ nativeModel: "claude-haiku-4-5", providers: [{ provider: "duckduckgo-html" }] });
		const registry = registryWith([sessionOpus, proxyHaiku]);
		const { requests, fetchMock } = captureFetch([() => anthropicSearchResponse("https://example.com/a")]);
		vi.stubGlobal("fetch", fetchMock);
		const { sessionStart, status, tool } = loadExtension();
		const ui = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() };
		await sessionStart(
			{ type: "session_start" },
			{ cwd, model: sessionOpus, modelRegistry: registry, hasUI: false, ui },
		);
		await tool.execute(
			"status-search",
			{ query: "status search" },
			undefined,
			undefined,
			toolContext(sessionOpus, registry) as ExtensionToolContext,
		);
		const notify = vi.fn();

		// when
		await status("status", { ui: { notify }, model: sessionOpus, modelRegistry: registry });

		// then
		expect(requests.map((request) => request.model)).toEqual(["claude-haiku-4-5"]);
		const [message, level] = notify.mock.calls[0] ?? [];
		expect(level).toBe("info");
		expect(message).toContain("native model=claude-haiku-4-5 (falls back to claude-opus-4-5)");
		expect(message).toContain("last search via claude-proxy/native (claude-haiku-4-5)");
	});
});
