import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK_AT_CHAIN } from "../../src/core/extensions/builtin/look-at/model-selector.ts";
import {
	createLookAtStore,
	loadLookAtChain,
	loadLookAtEnabled,
} from "../../src/core/extensions/builtin/look-at/settings.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

function context(models?: string[], enabled = true): Pick<ExtensionContext, "getLookAtSettings"> {
	return { getLookAtSettings: () => ({ enabled, models }) };
}

describe("look-at settings", () => {
	it("uses configured models instead of the default chain", () => {
		const ctx = context(["google/gemini-3.5-flash"]);

		expect(loadLookAtChain(ctx, createLookAtStore())).toEqual(["google/gemini-3.5-flash"]);
	});

	it("prefers an in-memory override over configured models", () => {
		const store = createLookAtStore();
		store.setModels(["openai/gpt-5.6-terra"]);

		expect(loadLookAtChain(context(["google/gemini-3.5-flash"]), store)).toEqual(["openai/gpt-5.6-terra"]);
	});

	it("uses enabled defaults and the default chain", () => {
		const store = createLookAtStore();

		expect(loadLookAtEnabled(context(undefined, true), store)).toBe(true);
		expect(loadLookAtChain(context(), store)).toEqual(DEFAULT_LOOK_AT_CHAIN);
	});

	it("keeps store overrides isolated per instance", () => {
		const first = createLookAtStore();
		const second = createLookAtStore();
		first.setEnabled(false);
		first.setModels(["moonshotai/kimi-k3"]);

		expect(loadLookAtEnabled(context(), first)).toBe(false);
		expect(loadLookAtChain(context(), first)).toEqual(["moonshotai/kimi-k3"]);
		expect(loadLookAtEnabled(context(), second)).toBe(true);
		expect(loadLookAtChain(context(), second)).toEqual(DEFAULT_LOOK_AT_CHAIN);
	});
});
