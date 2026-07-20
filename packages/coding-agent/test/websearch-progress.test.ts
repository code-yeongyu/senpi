import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import { renderSearchResult } from "../src/core/extensions/builtin/websearch/websearch/renderers.ts";
import { createWebSearchTool } from "../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type {
	SearchProgressDetails,
	WebsearchConfig,
} from "../src/core/extensions/builtin/websearch/websearch/types.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

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
		expect(progress[1]?.currentProvider).toBe("exa/primary");
		expect(progress[1]?.attempts).toEqual([]);
		expect(progress[2]?.currentProvider).toBe("exa/backup");
		expect(progress[2]?.attempts).toHaveLength(1);
		expect(progress[2]?.attempts?.[0]?.error).toContain("HTTP 500");
		expect(result.details && "provider" in result.details ? result.details.entryId : undefined).toBe("backup");
	});

	it("#given per-attempt progress details #when rendering partial output #then shows only the current provider with its step position", () => {
		// given
		const details: SearchProgressDetails = {
			phase: "searching",
			query: "attempt progress",
			providerLabels: ["exa/primary", "exa/backup"],
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
		expect(collapsed).toContain('Searching "attempt progress" via exa/backup [2/2] (max 10)');
		expect(collapsed).not.toContain("exa/primary ->");
		expect(expanded).toContain("route exa/primary:failed");
	});
});
