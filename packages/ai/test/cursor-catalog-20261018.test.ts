// senpi#3620
import { describe, expect, it } from "vitest";
import { normalizeCursorCatalog } from "../src/cursor/catalog-grouping.ts";
import { getCursorCapabilityForBase } from "../src/cursor/model-capabilities.ts";
import { cursorDiscoveredInput } from "../src/cursor/model-input.ts";
import fixture from "./fixtures/cursor-usable-models-20261018.json" with { type: "json" };

const serverWindow = fixture.serverWindow as Record<string, number>;

function normalized() {
	return normalizeCursorCatalog(
		fixture.models.map((entry) => ({
			id: entry.id,
			name: entry.name,
			input: entry.input as ("text" | "image")[],
			cursorMaxMode: entry.cursorMaxMode,
		})),
	);
}

describe("cursor families published after the 2026-08-18 capture (senpi#3620)", () => {
	it("gives every live family a capability entry, so none falls back to the placeholder window", () => {
		for (const family of Object.keys(serverWindow)) {
			expect(getCursorCapabilityForBase(family), `missing capability for ${family}`).toBeDefined();
		}
	});

	it("advertises exactly the window the server reported for the request senpi sends", () => {
		const drift: string[] = [];
		for (const entry of normalized()) {
			const family = entry.capabilityId ?? entry.id;
			const reported = serverWindow[family];
			if (reported !== undefined && entry.window !== reported) {
				drift.push(`${entry.id}: advertises ${entry.window}, server serves ${reported}`);
			}
		}
		expect(drift).toEqual([]);
	});

	it("keeps the larger context Cursor offers as maxWindow without advertising it", () => {
		expect(getCursorCapabilityForBase("claude-opus-5-5")?.maxWindow).toBe(1_000_000);
		expect(getCursorCapabilityForBase("grok-4.7")?.maxWindow).toBe(500_000);
		expect(getCursorCapabilityForBase("gemini-4-argon")?.maxWindow).toBeUndefined();
	});

	it("applies the family window to the flat fast variants too", () => {
		const byId = new Map(normalized().map((entry) => [entry.id, entry]));
		expect(byId.get("claude-opus-5-5-high-fast")?.window).toBe(300_000);
		expect(byId.get("grok-4.7-xhigh-fast")?.window).toBe(256_000);
	});

	it("names the Haiku 5.5 thinking split after what each group does", () => {
		const names = new Map(normalized().map((entry) => [entry.id, entry.name]));
		expect(names.get("claude-haiku-5-5")).toBe("Claude Haiku 5.5");
		expect(names.get("claude-haiku-5-5-thinking")).toBe("Claude Haiku 5.5 Thinking");
	});

	it("drops the 1M size token from groups the server serves at 300k", () => {
		const names = new Map(normalized().map((entry) => [entry.id, entry.name]));
		expect(names.get("claude-opus-5-5")).toBe("Claude Opus 5.5");
		expect(names.get("claude-fable-5-1")).toBe("Claude Fable 5.1 (NO ZDR)");
		expect(names.get("claude-fable-5-1-thinking")).toBe("Claude Fable 5.1 Thinking (NO ZDR)");
		expect(names.get("muse-spark-1.3")).toBe("Muse Spark 1.3");
	});

	it("keeps no 1M token on any served-checkpoint entry whose window is smaller", () => {
		const servedFamilies = ["claude-opus-5-5", "claude-fable-5-1", "muse-spark-1.3"];
		const offenders = normalized()
			.filter(
				(entry) =>
					servedFamilies.some((family) => entry.id.startsWith(family)) &&
					entry.window < 1_000_000 &&
					/1M/.test(entry.name),
			)
			.map((entry) => `${entry.id}: ${entry.name}`);
		expect(offenders).toEqual([]);
		const names = new Map(normalized().map((entry) => [entry.id, entry.name]));
		expect(names.get("claude-opus-5-5-high-fast")).toBe("Claude Opus 5.5 High Fast");
	});

	it("keeps the 1M token where the window is 1M, and where only Cursor advertises it (#3621 scope)", () => {
		const names = new Map(normalized().map((entry) => [entry.id, entry.name]));
		expect(names.get("claude-4.6-opus")).toBe("Claude Opus 4.6 1M");
		expect(names.get("gpt-5.4")).toBe("GPT-5.4 1M");
		expect(names.get("gpt-5.6-terra")).toBe("GPT-5.6 Terra 1M");
	});

	it("strips zero-width characters and doubled spaces from display names", () => {
		for (const entry of normalized()) {
			expect(entry.name, entry.id).not.toMatch(/[\u200B-\u200D\uFEFF]| {2}/);
		}
		const names = new Map(normalized().map((entry) => [entry.id, entry.name]));
		expect(names.get("grok-4.7-high-fast")).toBe("Grok 4.7 High Fast");
	});

	it("accepts images exactly where AvailableModels reports supportsImages", () => {
		for (const id of [
			"muse-wonder-1.0-high",
			"muse-spark-1.3-low",
			"kimi-k3-max",
			"cursor-grok-4.6-high",
			"cursor-grok-4.5-low",
			"gemini-4-argon-medium",
			"claude-haiku-5-5-thinking-low",
			"default",
		]) {
			expect(cursorDiscoveredInput(id), id).toEqual(["text", "image"]);
		}
		for (const id of ["composer-2.5", "kimi-k2.7-code", "grok-4.7-high", "grok-code-fast-1", "glm-5.2-high"]) {
			expect(cursorDiscoveredInput(id), id).toEqual(["text"]);
		}
	});
});
