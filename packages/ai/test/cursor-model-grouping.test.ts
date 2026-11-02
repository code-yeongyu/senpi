import { describe, expect, it } from "vitest";
import { normalizeCursorCatalog, parseCursorVariantId } from "../src/cursor/catalog-grouping.ts";
import { getCursorVariantAlias } from "../src/cursor/model-capabilities.ts";
import fixture from "./fixtures/cursor-usable-models-20260818.json" with { type: "json" };

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function normalized() {
	return normalizeCursorCatalog(
		fixture.map((entry) => ({
			id: entry.id,
			name: entry.name,
			input: entry.input as ("text" | "image")[],
			cursorMaxMode: entry.cursorMaxMode,
		})),
	);
}

describe("normalizeCursorCatalog (golden 204-id live fixture)", () => {
	it("collapses 204 variants to 113 outputs with 32 reasoning identities", () => {
		const out = normalized();
		expect(out).toHaveLength(113);
		expect(out.filter((entry) => entry.reasoning)).toHaveLength(32);
	});

	it("splits the Claude boolean axis into separate selectable identities", () => {
		const out = normalized();
		const plain = out.find((entry) => entry.id === "claude-fable-5");
		const thinking = out.find((entry) => entry.id === "claude-fable-5-thinking");
		expect(plain?.reasoning).toBe(true);
		expect(thinking?.reasoning).toBe(true);
		expect(plain?.thinkingMode).toBe(false);
		expect(thinking?.thinkingMode).toBe(true);
		for (const identity of [plain, thinking]) {
			expect(identity?.thinkingLevelMap?.low).toBe("low");
			expect(identity?.thinkingLevelMap?.max).toBe("max");
		}
	});

	it("assigns total seven-key maps with exact wire values to every reasoning identity", () => {
		const out = normalized();
		for (const entry of out.filter((candidate) => candidate.reasoning)) {
			for (const level of ALL_LEVELS) {
				expect(Object.hasOwn(entry.thinkingLevelMap ?? {}, level), `${entry.id} missing key ${level}`).toBe(true);
			}
		}
	});

	it("pins per-family maps and translations", () => {
		const out = normalized();
		const byId = new Map(out.map((entry) => [entry.id, entry]));
		expect(byId.get("gpt-5.5")?.thinkingLevelMap?.xhigh).toBe("extra-high");
		expect(byId.get("gpt-5.3-codex")?.thinkingLevelMap?.xhigh).toBe("extra-high");
		expect(byId.get("gpt-5.6-sol")?.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(byId.get("cursor-grok-4.5")?.thinkingLevelMap?.xhigh).toBeNull();
		expect(byId.get("cursor-grok-4.6")?.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(byId.get("glm-5.2")?.thinkingLevelMap).toMatchObject({ high: "high", max: "max", low: null });
		expect(byId.get("kimi-k3")?.thinkingLevelMap).toMatchObject({
			low: "low",
			high: "high",
			max: "max",
			medium: null,
		});
		expect(byId.get("gemini-3.6-flash")?.thinkingLevelMap?.minimal).toBe("minimal");
		expect(byId.get("gemini-3.7-flash")?.thinkingLevelMap?.minimal).toBeNull();
	});

	it("exposes off=none only where the descriptor declares it", () => {
		const out = normalized();
		const byId = new Map(out.map((entry) => [entry.id, entry]));
		for (const id of ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.4-mini", "gpt-5.4-nano"]) {
			expect(byId.get(id)?.thinkingLevelMap?.off, id).toBe("none");
		}
		for (const id of [
			"claude-fable-5",
			"kimi-k3",
			"glm-5.2",
			"cursor-grok-4.6",
			"gemini-3.7-flash",
			"gpt-5.3-codex",
		]) {
			expect(byId.get(id)?.thinkingLevelMap?.off, id).toBeNull();
		}
	});

	it("keeps fast variants raw and level-less twins untouched", () => {
		const out = normalized();
		const ids = new Set(out.map((entry) => entry.id));
		expect(ids.has("claude-opus-4-7-thinking-high-fast")).toBe(true);
		expect(ids.has("composer-2.5-fast")).toBe(true);
		expect(ids.has("claude-4-sonnet-thinking")).toBe(true);
		expect(ids.has("claude-4.5-sonnet-thinking")).toBe(true);
		for (const rawId of ["claude-opus-4-7-thinking-high-fast", "composer-2.5-fast", "claude-4-sonnet-thinking"]) {
			expect(out.find((entry) => entry.id === rawId)?.reasoning).toBe(false);
		}
	});

	it("assigns static windows and keeps display qualifiers", () => {
		const out = normalized();
		const byId = new Map(out.map((entry) => [entry.id, entry]));
		expect(byId.get("kimi-k3")?.window).toBe(1048576);
		expect(byId.get("claude-fable-5")?.window).toBe(1000000);
		expect(byId.get("claude-fable-5")?.maxWindow).toBe(1000000);
		expect(byId.get("claude-fable-5")?.name).toContain("1M");
		expect(byId.get("claude-fable-5")?.name).toContain("NO ZDR");
	});

	it("records legacy aliases for grouped identities", () => {
		const out = normalized();
		const fable = out.find((entry) => entry.id === "claude-fable-5-thinking");
		expect(fable?.legacyAliases).toContain("claude-fable-5-thinking-xhigh");
		expect(fable?.legacyAliases).toContain("claude-fable-5-thinking-low");
		expect(fable?.legacyAliases).not.toContain("claude-fable-5-low");
	});
});

describe("parseCursorVariantId", () => {
	it("parses every fixture id and round-trips via originalId", () => {
		for (const entry of fixture) {
			const parsed = parseCursorVariantId(entry.id);
			expect(parsed.originalId).toBe(entry.id);
			expect(parsed.baseId.length).toBeGreaterThan(0);
		}
	});

	it("handles both thinking/level orders", () => {
		expect(parseCursorVariantId("claude-fable-5-thinking-xhigh")).toMatchObject({
			baseId: "claude-fable-5",
			level: "xhigh",
			thinking: true,
			fast: false,
		});
		expect(parseCursorVariantId("claude-4.5-opus-high-thinking")).toMatchObject({
			baseId: "claude-4.5-opus",
			level: "high",
			thinking: true,
			fast: false,
		});
		expect(parseCursorVariantId("gpt-5.5-extra-high")).toMatchObject({
			baseId: "gpt-5.5",
			level: "extra-high",
			thinking: false,
		});
		expect(parseCursorVariantId("gpt-5.6-luna-none")).toMatchObject({
			baseId: "gpt-5.6-luna",
			level: "none",
			thinking: false,
		});
		expect(parseCursorVariantId("composer-2.5-fast")).toMatchObject({
			baseId: "composer-2.5",
			level: undefined,
			fast: true,
		});
	});

	it("never authorizes migration for syntactically plausible but unknown ids", () => {
		for (const id of ["custom-high", "custom-none", "some-model-thinking-low", "gpt-5.5[effort=high]"]) {
			expect(getCursorVariantAlias(id)).toBeUndefined();
		}
	});
});
