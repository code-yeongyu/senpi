import { describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ released: false, promoteDefaults: false }));
vi.mock("@earendil-works/pi-ai/utils/fable55-launch", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/utils/fable55-launch")>();
	return {
		...actual,
		FABLE55_LAUNCH: {
			...actual.FABLE55_LAUNCH,
			get released() {
				return flags.released;
			},
			get promoteDefaults() {
				return flags.promoteDefaults;
			},
		},
	};
});

// senpi#3893: optional promotion changes only the Fable slot, and only after both explicit flips.
describe("launch-gated recommended Fable slot", () => {
	it.each([
		[false, false, "claude-fable-5-1"],
		[false, true, "claude-fable-5-1"],
		[true, false, "claude-fable-5-1"],
		[true, true, "claude-fable-5-5"],
	] as const)("released=%s promoteDefaults=%s selects %s", async (released, promoteDefaults, expectedId) => {
		flags.released = released;
		flags.promoteDefaults = promoteDefaults;
		// The model list captures the launch configuration at module evaluation.
		vi.resetModules();
		const { RECOMMENDED_DEFAULT_MODELS } = await import(
			"../../src/core/extensions/builtin/recommended-models/index.ts"
		);
		expect(RECOMMENDED_DEFAULT_MODELS[0][0]).toBe("claude-opus-5-5");
		expect(RECOMMENDED_DEFAULT_MODELS[1]).toEqual([
			expectedId,
			"xhigh",
			["anthropic-subscription", "anthropic", "anthropic-api", "github-copilot", "opencode"],
		]);
	});
});
