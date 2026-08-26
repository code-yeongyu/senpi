import { describe, expect, it } from "vitest";
import {
	CURSOR_MODEL_CAPABILITIES,
	getCursorBaseIdForVariant,
	getCursorCapabilityForBase,
	parseCursorVariantId,
} from "../src/cursor/model-capabilities.ts";
import fixture from "./fixtures/cursor-usable-models-20260818.json" with { type: "json" };

/**
 * C1 — capability table and context windows.
 * Values are pinned by the live AvailableModels capture of 2026-08-18
 * (evidence: available-models-catalog.json); see .omo/plans/cursor-reasoning-levels.md §6.
 */
describe("cursor model capabilities", () => {
	it("assigns the exact live-catalog window to every family base", () => {
		const expected: Record<string, number> = {
			"kimi-k3": 1048576,
			"glm-5.2": 1000000,
			"gemini-3.6-flash": 1048576,
			"gemini-3.7-flash": 1048576,
			"gpt-5.1": 400000,
			"gpt-5.2": 400000,
			"gpt-5.3-codex": 400000,
			"gpt-5.4": 400000,
			"gpt-5.4-mini": 400000,
			"gpt-5.4-nano": 400000,
			"gpt-5.5": 1000000,
			"gpt-5.6-sol": 1000000,
			"gpt-5.6-luna": 1000000,
			"gpt-5.6-terra": 272000,
			"cursor-grok-4.5": 500000,
			"cursor-grok-4.6": 500000,
			"kimi-k2.7-code": 262144,
			"claude-4.6-sonnet": 1000000,
			"claude-4.6-opus": 1000000,
			"claude-fable-5": 1000000,
			"claude-sonnet-5": 1000000,
			"claude-opus-4-7": 1000000,
			"claude-opus-4-8": 1000000,
			"claude-opus-5": 1000000,
			"composer-2.5": 200000,
			"claude-haiku-4-5": 200000,
			"claude-4-sonnet": 200000,
			"claude-4.5-sonnet": 200000,
			"claude-4.5-opus": 200000,
		};
		for (const [base, window] of Object.entries(expected)) {
			const cap = getCursorCapabilityForBase(base);
			expect(cap, `missing capability for ${base}`).toBeDefined();
			expect(cap?.window, `${base} window`).toBe(window);
		}
	});

	it("keeps window and maxWindow distinct", () => {
		const fable = getCursorCapabilityForBase("claude-fable-5");
		expect(fable?.window).toBe(1000000);
		expect(fable?.maxWindow).toBe(1000000);
		expect(fable?.defaultContext).toBe("300k");
		const kimi = getCursorCapabilityForBase("kimi-k3");
		expect(kimi?.window).toBe(1048576);
		expect(kimi?.maxWindow).toBeUndefined();
	});

	it("resolves a variant id to its base capability with the same window", () => {
		expect(getCursorBaseIdForVariant("kimi-k3-max")).toBe("kimi-k3");
		expect(getCursorBaseIdForVariant("claude-fable-5-thinking-xhigh")).toBe("claude-fable-5");
		expect(getCursorBaseIdForVariant("claude-opus-4-7-thinking-high-fast")).toBe("claude-opus-4-7");
		expect(getCursorCapabilityForBase(getCursorBaseIdForVariant("kimi-k3-max")!)?.window).toBe(1048576);
	});

	it("covers every parsed base from the 204-id live fixture or documents the fallback", () => {
		const uncovered = new Set<string>();
		for (const entry of fixture) {
			const parsed = parseCursorVariantId(entry.id);
			if (!parsed) continue;
			if (getCursorCapabilityForBase(parsed.baseId) === undefined) {
				uncovered.add(parsed.baseId);
			}
		}
		// Only the bare `default` pseudo-model may lack a capability entry.
		expect([...uncovered].sort()).toEqual(["default"]);
	});

	it("marks evidence provenance for every entry", () => {
		for (const [id, cap] of Object.entries(CURSOR_MODEL_CAPABILITIES)) {
			expect(["available-models", "cli-live", "suffix-only"], `${id} evidence`).toContain(cap.evidence);
		}
	});
});
