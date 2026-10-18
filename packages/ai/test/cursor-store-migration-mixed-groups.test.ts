// senpi#2038
import { describe, expect, it } from "vitest";
import { regroupStoredCursorModels } from "../src/cursor/store-migration.ts";
import { cursorProvider } from "../src/providers/cursor.ts";
import type { Model } from "../src/types.ts";

function storedFlat(id: string): Model<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		compat: {},
	};
}

function staticGroup(ids: readonly string[]): Model<"cursor-agent"> {
	const [group] = regroupStoredCursorModels(ids.map(storedFlat));
	if (group?.compat?.cursorReasoning === undefined) throw new Error(`expected ${ids.join(",")} to group`);
	return group;
}

async function restoreThroughProvider(stored: Model<"cursor-agent">[]): Promise<readonly Model<"cursor-agent">[]> {
	const provider = cursorProvider();
	if (provider.refreshModels === undefined) throw new Error("cursor provider must refresh stored models");
	await provider.refreshModels({
		stored: { models: stored, checkedAt: 1 },
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async ({ update }) => {
			update?.();
			return true;
		},
	});
	return provider.getModels();
}

describe("regroupStoredCursorModels with an existing static group beside flat aliases", () => {
	it("keeps a complete static group intact whichever side of a flat alias it is stored on", async () => {
		const complete = staticGroup(["kimi-k3-low", "kimi-k3-high", "kimi-k3-max"]);
		for (const stored of [
			[storedFlat("before"), storedFlat("kimi-k3-high"), complete, storedFlat("after")],
			[storedFlat("before"), complete, storedFlat("kimi-k3-high"), storedFlat("after")],
		]) {
			const out = regroupStoredCursorModels(stored);
			expect(out.map((model) => model.id)).toEqual(["before", "kimi-k3", "after"]);
			expect(out[1]).toEqual(complete);
			expect(regroupStoredCursorModels(out)).toEqual(out);

			const restored = (await restoreThroughProvider(stored)).find((model) => model.id === "kimi-k3");
			expect(restored?.thinkingLevelMap).toEqual(complete.thinkingLevelMap);
			expect(restored?.compat?.cursorReasoning?.representativeVariantId).toBe("kimi-k3-low");
		}
	});

	it("absorbs a level the static group lacks without replacing its representative", () => {
		const partial = staticGroup(["kimi-k3-low"]);
		for (const stored of [
			[partial, storedFlat("kimi-k3-max")],
			[storedFlat("kimi-k3-max"), partial],
		]) {
			const out = regroupStoredCursorModels(stored);
			expect(out.map((model) => model.id)).toEqual(["kimi-k3"]);
			expect(out[0]?.thinkingLevelMap).toEqual({ ...partial.thinkingLevelMap, max: "max" });
			expect(out[0]?.compat).toEqual(partial.compat);
			expect(regroupStoredCursorModels(out)).toEqual(out);
		}
	});
});
