import assert from "node:assert";
import { describe, it } from "node:test";
import { decideTmuxImageCapability } from "../src/tmux-image-capability.ts";
import type { TmuxImageState } from "../src/tmux-image-probe.ts";

function readyState(overrides: Partial<Extract<TmuxImageState, { kind: "tmux" }>> = {}): TmuxImageState {
	return {
		kind: "tmux",
		version: "3.7b",
		supportTier: "on-and-all",
		allowPassthrough: "on",
		focusEvents: true,
		paneActive: true,
		windowActive: true,
		visible: true,
		clientCount: 1,
		clientTermname: "xterm-ghostty",
		nested: false,
		hyperlinks: true,
		cellDimensions: { widthPx: 9, heightPx: 18 },
		...overrides,
	};
}

describe("tmux image capability gating", () => {
	it("enables only safe live placeholder clients", () => {
		const on = decideTmuxImageCapability(readyState(), undefined);
		const all = decideTmuxImageCapability(readyState({ allowPassthrough: "all" }), undefined);

		assert.deepStrictEqual(on, { enabled: true, placement: "placeholder", terminal: "ghostty" });
		assert.deepStrictEqual(all, { enabled: true, placement: "placeholder", terminal: "ghostty" });
	});

	it("does not trust generic clients or stale process environment", () => {
		const decision = decideTmuxImageCapability(readyState({ clientTermname: "xterm-256color" }), undefined);
		assert.deepStrictEqual(decision, { enabled: false, reason: "unknown-client" });
	});

	it("supports Warp from live identity or explicit override", () => {
		const live = decideTmuxImageCapability(readyState({ clientTermname: "xterm-warp" }), undefined);
		const overridden = decideTmuxImageCapability(readyState({ clientTermname: "xterm-256color" }), "warp");

		assert.deepStrictEqual(live, { enabled: true, placement: "direct", terminal: "warp" });
		assert.deepStrictEqual(overridden, { enabled: true, placement: "direct", terminal: "warp" });
	});

	it("supports Rex from live xterm-rex identity or explicit override", () => {
		const on = decideTmuxImageCapability(readyState({ clientTermname: "xterm-rex" }), undefined);
		const all = decideTmuxImageCapability(
			readyState({ allowPassthrough: "all", clientTermname: "xterm-rex" }),
			undefined,
		);
		const overridden = decideTmuxImageCapability(readyState({ clientTermname: "xterm-256color" }), "rex");
		const unrelated = decideTmuxImageCapability(readyState({ clientTermname: "xterm-terex" }), undefined);

		assert.deepStrictEqual(on, { enabled: true, placement: "placeholder", terminal: "rex" });
		assert.deepStrictEqual(all, { enabled: true, placement: "placeholder", terminal: "rex" });
		assert.deepStrictEqual(overridden, { enabled: true, placement: "placeholder", terminal: "rex" });
		assert.deepStrictEqual(unrelated, { enabled: false, reason: "unknown-client" });
	});

	it("keeps WezTerm direct placement disabled", () => {
		const decision = decideTmuxImageCapability(readyState({ clientTermname: "xterm-wezterm" }), undefined);
		assert.deepStrictEqual(decision, { enabled: false, reason: "unknown-client" });
	});

	it("disables unsafe topology and visibility states", () => {
		const cases = [
			{ state: readyState({ nested: true }), reason: "nested" },
			{ state: readyState({ clientCount: 2, visible: false }), reason: "multiple-clients" },
			{ state: readyState({ visible: false, windowActive: false }), reason: "hidden" },
			{ state: readyState({ focusEvents: false }), reason: "focus-events-off" },
			{ state: readyState({ supportTier: "unsupported" }), reason: "unsupported-version" },
			{ state: readyState({ allowPassthrough: "off" }), reason: "passthrough-off" },
		] as const;

		for (const testCase of cases) {
			assert.deepStrictEqual(decideTmuxImageCapability(testCase.state, undefined), {
				enabled: false,
				reason: testCase.reason,
			});
		}
	});

	it("rejects direct placement when passthrough is all", () => {
		const decision = decideTmuxImageCapability(
			readyState({ allowPassthrough: "all", clientTermname: "xterm-warp" }),
			undefined,
		);
		assert.deepStrictEqual(decision, { enabled: false, reason: "unsafe-direct-placement" });
	});
});
