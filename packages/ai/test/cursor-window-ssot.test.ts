import { describe, expect, it } from "vitest";
import { CURSOR_MODEL_CAPABILITIES } from "../src/cursor/model-capabilities.ts";
import ssot from "./fixtures/models-dev-first-party-windows-20260818.json" with { type: "json" };

const contextEnum = ssot.cursorContextEnum as Record<string, number>;
const offered = ssot.cursorContextOptionsByFamily as Record<string, readonly string[]>;
const firstParty = ssot.firstParty as Record<string, { context: number }>;
const reported = ssot.cursorReportedWindow as Record<string, number>;

/** Cursor only honours a window it actually offers that family, so the spec value is capped by it. */
function expectedWindow(family: string): number | undefined {
	const options = offered[family];
	if (options && options.length > 0) {
		const cap = Math.max(...options.map((option) => contextEnum[option]));
		const spec = firstParty[family]?.context;
		return spec === undefined ? cap : Math.min(spec, cap);
	}
	const spec = firstParty[family]?.context;
	if (spec !== undefined) return spec;
	return reported[family];
}

describe("cursor capability windows track the models.dev first-party SSOT", () => {
	it("caps each family at the largest context option cursor offers it", () => {
		const drift: string[] = [];
		for (const [family, capability] of Object.entries(CURSOR_MODEL_CAPABILITIES)) {
			const expected = expectedWindow(family);
			if (expected === undefined) continue;
			if (capability.window !== expected) {
				drift.push(`${family}: committed ${capability.window} != SSOT ${expected}`);
			}
		}
		expect(drift).toEqual([]);
	});

	it("never advertises a window above the largest context option cursor offers", () => {
		for (const [family, capability] of Object.entries(CURSOR_MODEL_CAPABILITIES)) {
			const options = offered[family];
			if (!options || options.length === 0) continue;
			const cap = Math.max(...options.map((option) => contextEnum[option]));
			expect(capability.window, `${family} exceeds the context cursor offers it`).toBeLessThanOrEqual(cap);
		}
	});

	it("keeps families outside the SSOT on a positive fallback window", () => {
		for (const [family, capability] of Object.entries(CURSOR_MODEL_CAPABILITIES)) {
			if (expectedWindow(family) !== undefined) continue;
			expect(capability.window, `${family} must carry a positive window`).toBeGreaterThan(0);
		}
	});
});

describe("cursor window edges", () => {
	const CLI_ONLY = [
		"claude-mythos-5",
		"claude-sonnet-4-7",
		"composer-2.6",
		"composer-2.6-lite",
		"deepseek-v4",
		"gemini-3.5-pro",
		"gemini-3.6-pro",
		"gemini-3.7-pro",
		"gpt-5.4-codex",
	] as const;

	it("leaves CLI-only families without a capability entry so they take the documented fallback", () => {
		for (const family of CLI_ONLY) {
			expect(
				Object.hasOwn(CURSOR_MODEL_CAPABILITIES, family),
				`${family} is CLI-only and must not gain an unproven capability window`,
			).toBe(false);
		}
	});

	it("keeps genuinely small-window families off the 1M promotion", () => {
		for (const family of ["claude-4.5-opus", "claude-haiku-4-5", "composer-2.5"] as const) {
			const capability = CURSOR_MODEL_CAPABILITIES[family];
			expect(capability, `missing capability for ${family}`).toBeDefined();
			expect(capability?.window, `${family} must stay at its first-party 200000`).toBe(200_000);
		}
	});

	it("never lets a family advertise more than its own maxWindow when one is declared", () => {
		for (const [family, capability] of Object.entries(CURSOR_MODEL_CAPABILITIES)) {
			if (capability.maxWindow === undefined) continue;
			expect(capability.window, `${family} window exceeds maxWindow`).toBeLessThanOrEqual(capability.maxWindow);
		}
	});
});
