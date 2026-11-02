import { describe, expect, it } from "vitest";
import {
	buildBm25Index,
	DEFAULT_BM25_PRECISION,
	stemToken,
} from "../../src/core/extensions/builtin/tool-search/engine/bm25.ts";
import type { ToolSearchDocument } from "../../src/core/extensions/builtin/tool-search/engine/document.ts";
import { ToolSearchService } from "../../src/core/extensions/builtin/tool-search/service.ts";

function doc(name: string, description: string, keywords: readonly string[] = []): ToolSearchDocument {
	return {
		name,
		label: name,
		aliases: [],
		description,
		keywords,
		source: "extension",
		group: "catalog",
		ownerLabel: "catalog",
		registrationId: `registration:${name}`,
	};
}

const SAMPLED_CATALOG: ToolSearchDocument[] = [
	doc("x_search", "Searches X (Twitter) posts through xAI. Date-bound every time-sensitive query.", [
		"X posts",
		"tweets",
		"twitter search",
	]),
	doc(
		"thread_handoff",
		"Moves the current request to an old session so the previous conversation continues there instead of here",
		["continue in old session", "hand off to a previous session"],
	),
	doc("task_get", "Reads one entry of the shared team task list", ["task details", "read a task"]),
	doc("weather_forecast", "Get hourly weather forecasts and rain predictions"),
];

function names(results: readonly { name: string }[]): string[] {
	return results.map((result) => result.name);
}

describe("tool-search precision gate", () => {
	const index = buildBm25Index(SAMPLED_CATALOG);
	const precise = { precision: DEFAULT_BM25_PRECISION };

	it("drops incidental single-term hits that the ungated engine still returns", () => {
		const query = "recall memory search previous conversation messages";
		expect(names(index.search(query, 10))).toContain("x_search");
		expect(index.search(query, 10, precise)).toEqual([]);
	});

	it("keeps a hit whose content terms are mostly covered", () => {
		expect(names(index.search("hourly rain forecast", 10, precise))).toEqual(["weather_forecast"]);
		expect(names(index.search("twitter search for tweets", 10, precise))).toEqual(["x_search"]);
	});

	it("ignores stopwords when measuring coverage and folds plurals onto singulars", () => {
		expect(names(index.search("a tool to read the task", 10, precise))).toEqual(["task_get"]);
		expect(names(index.search("weather forecasts", 10, precise))).toEqual(["weather_forecast"]);
		expect(stemToken("messages")).toBe("message");
		expect(stemToken("libraries")).toBe("library");
		expect(stemToken("status")).toBe("status");
		expect(stemToken("class")).toBe("class");
		expect(stemToken("docs")).toBe("doc");
	});

	it("keeps an exact name match regardless of coverage", () => {
		expect(names(index.search("thread-handoff", 10, precise))).toEqual(["thread_handoff"]);
	});

	it("drops a weak second hit below the relative score floor even when coverage passes", () => {
		const floorOnly = buildBm25Index([
			doc("full_match", "alpha beta gamma delta"),
			doc("partial_match", "alpha and a great many other unrelated words fill this description out"),
		]);
		const lenient = floorOnly.search("alpha beta", 10, { precision: { minCoverage: 0, minScoreRatio: 0 } });
		expect(names(lenient)).toEqual(["full_match", "partial_match"]);
		const floored = floorOnly.search("alpha beta", 10, { precision: { minCoverage: 0, minScoreRatio: 0.9 } });
		expect(names(floored)).toEqual(["full_match"]);
	});

	it("reports coverage on every result", () => {
		const [best] = index.search("hourly rain forecast", 10, precise);
		expect(best?.coverage).toBe(1);
	});
});

describe("ToolSearchService hidden-tool hints", () => {
	function service(hints: Readonly<Record<string, string>>): ToolSearchService {
		const instance = new ToolSearchService({
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
		});
		instance.bindRemovedToolHints(() => hints);
		return instance;
	}

	it("answers a query that names a hidden tool with that tool's hint, once, in query order", () => {
		const hints = {
			bash: 'Run bash inside an eval cell via tool.bash({ command: "..." }); hooks and permissions still apply.',
			monitor: "Run monitor inside an eval cell via tool.monitor({ ... }).",
		};
		expect(service(hints).hiddenToolHints("bash execute shell command")).toEqual([
			{ name: "bash", hint: hints.bash },
		]);
		expect(service(hints).hiddenToolHints("monitor a command then bash, then monitor again")).toEqual([
			{ name: "monitor", hint: hints.monitor },
			{ name: "bash", hint: hints.bash },
		]);
		expect(service(hints).hiddenToolHints("Bash")).toEqual([{ name: "bash", hint: hints.bash }]);
	});

	it("returns nothing when no hidden tool is named or no hints are bound", () => {
		expect(service({ bash: "hint" }).hiddenToolHints("teleportation quantum xyzzy")).toEqual([]);
		expect(service({}).hiddenToolHints("bash")).toEqual([]);
	});

	it("applies the precision gate to catalog searches by default", () => {
		const instance = new ToolSearchService({
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
		});
		instance.feed(
			"mcp",
			SAMPLED_CATALOG.map((entry) => ({ ...entry, source: "mcp" as const })),
			{
				activate: () => undefined,
			},
		);
		expect(instance.search("recall memory search previous conversation messages")).toEqual([]);
		expect(names(instance.search("hourly rain forecast"))).toEqual(["weather_forecast"]);
	});
});
