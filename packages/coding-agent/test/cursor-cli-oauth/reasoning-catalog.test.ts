import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseCursorAgentModelsListing,
	STATIC_CURSOR_CLI_MODELS,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/models.ts";

const listing = readFileSync(join(import.meta.dirname, "fixtures/cursor-agent-models.txt"), "utf8");

describe("cursor-cli-oauth catalog normalization", () => {
	it("collapses the 204-id listing into grouped reasoning identities", () => {
		const models = parseCursorAgentModelsListing(listing);
		expect(models).toHaveLength(93);
		expect(models.filter((model) => model.reasoning)).toHaveLength(27);
	});

	it("assigns live-catalog context windows instead of label heuristics", () => {
		const byId = new Map(parseCursorAgentModelsListing(listing).map((model) => [model.id, model]));
		// Windows come from the shared live capability table, never from the
		// listing's own "(200K context)" labels, which are stale for Grok 4.6.
		expect(byId.get("cursor-grok-4.6")?.contextWindow).toBe(500_000);
		expect(byId.get("claude-fable-5")?.contextWindow).toBe(1_000_000);
		expect(byId.get("claude-opus-4-8")?.contextWindow).toBe(1_000_000);
	});

	it("exposes total thinking level maps with per-family wire values", () => {
		const byId = new Map(parseCursorAgentModelsListing(listing).map((model) => [model.id, model]));
		expect(byId.get("cursor-grok-4.6")?.thinkingLevelMap).toMatchObject({
			low: "low",
			medium: "medium",
			high: "high",
		});
		expect(byId.get("claude-fable-5-thinking")?.thinkingLevelMap?.max).toBe("max");
		expect(byId.get("claude-fable-5")?.thinkingLevelMap?.minimal).toBeNull();
	});

	it("keeps the offline static fallback usable with canonical ids and windows", () => {
		const byId = new Map(STATIC_CURSOR_CLI_MODELS.map((model) => [model.id, model]));
		expect(byId.get("cursor-grok-4.6")?.contextWindow).toBe(500_000);
		expect(STATIC_CURSOR_CLI_MODELS.some((model) => model.reasoning)).toBe(true);
	});
});
