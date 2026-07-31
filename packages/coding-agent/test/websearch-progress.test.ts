import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import { renderSearchResult } from "../src/core/extensions/builtin/websearch/websearch/renderers.ts";
import { formatSearchText } from "../src/core/extensions/builtin/websearch/websearch/search.ts";
import { createWebSearchTool } from "../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type {
	SearchDetails,
	SearchProgressDetails,
	WebsearchConfig,
} from "../src/core/extensions/builtin/websearch/websearch/types.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createInMemoryExtensionSessionSettings } from "./helpers/extension-session-settings.ts";

function minimalToolContext(): ExtensionContext {
	return {
		ui: Object.create(null) as ExtensionContext["ui"],
		mode: "print",
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: Object.create(null) as ExtensionContext["sessionManager"],
		modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		model: undefined,
		serviceTier: undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		getLookAtSettings: () => ({ enabled: true, models: undefined }),
		getImageSettings: () => ({ autoResize: true, blockImages: false }),
		sessionSettings: createInMemoryExtensionSessionSettings(),
		compact: vi.fn(),
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getSystemPrompt: () => "",
	};
}

const passthroughTheme = {
	bold: (value: string) => value,
	fg: (_key: string, value: string) => value,
};

function fallbackConfig(): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: false,
		providers: [
			{ id: "primary", provider: "exa", apiKey: "test-key" },
			{ id: "backup", provider: "exa", apiKey: "test-key" },
		],
	};
}

function exaSuccessResponse(): Response {
	return new Response(
		JSON.stringify({ results: [{ title: "Result", url: "https://example.com/a", text: "snippet" }] }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("websearch per-attempt progress", () => {
	it("#given a failing first provider #when the tool executes with fallback #then emits one progress update per attempt with the current provider", async () => {
		// given
		const responses = [new Response("boom", { status: 500 }), exaSuccessResponse()];
		const fetchMock = vi.fn<typeof fetch>(async () => {
			const next = responses.shift();
			if (!next) throw new Error("unexpected fetch call");
			return next;
		});
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config: fallbackConfig(), source: "test" }));
		const progress: SearchProgressDetails[] = [];

		// when
		const result = await tool.execute(
			"attempt-progress",
			{ query: "attempt progress" },
			undefined,
			(update) => {
				if (update.details && "phase" in update.details && update.details.phase === "searching") {
					progress.push(update.details);
				}
			},
			minimalToolContext(),
		);

		// then
		expect(progress).toHaveLength(3);
		expect(progress[0]?.currentProvider).toBeUndefined();
		expect(progress[0]?.providerLabels).toEqual(["exa/primary", "exa/backup"]);
		expect(progress[1]?.currentProvider).toBe("exa/primary");
		expect(progress[1]?.attempts).toEqual([]);
		expect(progress[2]?.currentProvider).toBe("exa/backup");
		expect(progress[2]?.attempts).toHaveLength(1);
		expect(progress[2]?.attempts?.[0]?.error).toContain("HTTP 500");
		expect(progress[2]?.routeLabels).toEqual(["exa/primary", "exa/backup"]);
		expect(result.details && "provider" in result.details ? result.details.entryId : undefined).toBe("backup");
	});

	it("#given per-attempt progress details #when rendering partial output #then shows only the current provider with its step position", () => {
		// given
		const details: SearchProgressDetails = {
			phase: "searching",
			query: "attempt progress",
			providerLabels: ["exa/primary", "exa/backup"],
			routeLabels: ["exa/primary", "exa/backup"],
			maxResults: 10,
			currentProvider: "exa/backup",
			attempts: [{ provider: "exa", entryId: "primary", durationMs: 12, resultsCount: 0, error: "HTTP 500" }],
		};

		// when
		const collapsed = renderSearchResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true },
			passthroughTheme,
		)
			.render(200)
			.join("\n");
		const expanded = renderSearchResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: true },
			passthroughTheme,
		)
			.render(200)
			.join("\n");

		// then
		expect(collapsed).toContain('Searching "attempt progress" via exa/backup (max 10)');
		expect(collapsed).not.toMatch(/\[\d+\/\d+\]/);
		expect(collapsed).not.toContain("exa/primary ->");
		expect(expanded).toContain("route exa/primary:failed -> exa/backup:searching");
	});

	it("#given three providers with the first failed and the second running #when rendering expanded partial output #then shows the three-state route string", () => {
		// given
		const details: SearchProgressDetails = {
			phase: "searching",
			query: "route render",
			providerLabels: ["exa/primary", "duckduckgo-html/backup", "brave/extra"],
			routeLabels: ["exa/primary", "duckduckgo-html/backup", "brave/extra"],
			maxResults: 10,
			currentProvider: "duckduckgo-html/backup",
			attempts: [{ provider: "exa", entryId: "primary", durationMs: 9, resultsCount: 0, error: "HTTP 500" }],
		};

		// when
		const collapsed = renderSearchResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true },
			passthroughTheme,
		)
			.render(200)
			.join("\n");
		const expanded = renderSearchResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: true },
			passthroughTheme,
		)
			.render(200)
			.join("\n");

		// then
		expect(collapsed).not.toMatch(/\[\d+\/\d+\]/);
		expect(expanded).toContain("route exa/primary:failed -> duckduckgo-html/backup:searching -> brave/extra:pending");
	});
});

describe("websearch native entry label collapse", () => {
	const nativeDetails: SearchDetails = {
		provider: "openai",
		entryId: "native-openai-abc123",
		query: "native label",
		results: [{ title: "Native", url: "https://example.com/native", snippet: "snip" }],
		durationMs: 7,
		truncated: false,
		strategy: "priority",
		attempts: [{ provider: "openai", entryId: "native-openai-abc123", durationMs: 7, resultsCount: 1 }],
	};

	it("#given finished details with native-openai entryId #when rendering collapsed summary #then collapses to openai/native", () => {
		// when
		const rendered = renderSearchResult(
			{ content: [{ type: "text", text: "ok" }], details: nativeDetails },
			{ expanded: false },
			passthroughTheme,
		)
			.render(200)
			.join("\n");

		// then
		expect(rendered).toContain("via openai/native");
		expect(rendered).not.toContain("native-openai-abc123");
	});

	it("#given finished details with native-openai entryId #when rendering expanded route #then collapses route line to openai/native:count", () => {
		// when
		const rendered = renderSearchResult(
			{ content: [{ type: "text", text: "ok" }], details: nativeDetails },
			{ expanded: true },
			passthroughTheme,
		)
			.render(200)
			.join("\n");

		// then
		expect(rendered).toContain("route openai/native:1");
		expect(rendered).not.toContain("native-openai-abc123");
	});

	it("#given finished details with native-openai entryId and priority strategy #when formatting text #then route fragment collapses to openai/native", () => {
		// when
		const text = formatSearchText(nativeDetails);

		// then
		expect(text).toContain("via openai/native");
		expect(text).not.toContain("(priority)");
		expect(text).not.toContain("native-openai-abc123");
	});
});
