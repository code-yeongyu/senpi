import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { EventLoopSlicer } from "../../src/core/event-loop-slicer.ts";
import {
	emitActivationMarker,
	LEGACY_TOOL_SEARCH_ACTIVATION_MARKER,
} from "../../src/core/extensions/builtin/tool-search/engine/marker.ts";
import { mayHoldActivationMarker } from "../../src/core/extensions/builtin/tool-search/engine/marker-candidates.ts";
import { ToolSearchService } from "../../src/core/extensions/builtin/tool-search/service.ts";
import type { ToolInfo } from "../../src/core/extensions/types.ts";

const v2Marker = emitActivationMarker([
	{ name: "weather_forecast", registrationId: "/workspace/extensions/weather-tools.ts\0weather_forecast" },
]);

class WithToJson {
	toJSON(): string {
		return v2Marker;
	}
}

function weatherService(): { service: ToolSearchService; active: string[] } {
	const tool: ToolInfo = {
		name: "weather_forecast",
		label: "Weather",
		description: "Forecast",
		parameters: Type.Object({}),
		sourceInfo: {
			path: "/workspace/extensions/weather-tools.ts",
			source: "test",
			scope: "temporary",
			origin: "top-level",
		},
		exposure: "search",
		searchKeywords: [],
		allowLazyActivation: true,
	};
	const active: string[] = [];
	const service = new ToolSearchService({
		getAllTools: () => [tool],
		getActiveTools: () => [...active],
		setActiveTools: (names) => active.splice(0, active.length, ...names),
	});
	return { service, active };
}

describe("activation marker candidates (senpi#3518)", () => {
	it("flags every message whose serialization holds a marker, and only those", () => {
		const cyclic: Record<string, unknown> = { note: "plain" };
		cyclic.self = cyclic;
		const withMarker = [
			{ role: "toolResult", content: [{ type: "text", text: `found ${v2Marker}` }] },
			{ content: `${LEGACY_TOOL_SEARCH_ACTIVATION_MARKER} mcp_a mcp_b` },
			{ deep: { list: [1, null, { text: `quoted "${v2Marker}"` }] } },
			{ [LEGACY_TOOL_SEARCH_ACTIVATION_MARKER]: true },
			{ wrapped: new WithToJson() },
			{ boxed: new String(v2Marker) },
		];
		const withoutMarker = [
			{ role: "user", content: [{ type: "text", text: "[tool_search] activated" }] },
			{ list: ["[tool", "_search:activated"] },
			{ fn: () => v2Marker, missing: undefined },
			cyclic,
		];
		for (const message of withMarker) expect(mayHoldActivationMarker(message)).toBe(true);
		for (const message of withoutMarker) expect(mayHoldActivationMarker(message)).toBe(false);
		for (const message of [...withMarker.slice(0, 4), withoutMarker[0], withoutMarker[1], withoutMarker[2]]) {
			expect(JSON.stringify(message).includes("[tool_search:activated")).toBe(mayHoldActivationMarker(message));
		}
	});

	it("restores the same tools as the synchronous scan while yielding between messages", async () => {
		const history = [
			...Array.from({ length: 500 }, (_, index) => ({ role: "user", content: `message ${index}` })),
			{ role: "toolResult", content: [{ type: "text", text: v2Marker }] },
		];
		const expected = weatherService();
		expect(expected.service.maybeRehydrateFromHistory(history)).toEqual(["weather_forecast"]);

		let now = 0;
		const slicer = new EventLoopSlicer({ clock: () => now++ });
		let turns = 0;
		let running = true;
		const tick = (): void => {
			if (!running) return;
			turns++;
			setImmediate(tick);
		};
		setImmediate(tick);
		const sliced = weatherService();
		const restored = await sliced.service.maybeRehydrateFromHistoryInSlices(history, slicer);
		running = false;

		expect(restored).toEqual(["weather_forecast"]);
		expect(sliced.active).toEqual(expected.active);
		expect(turns).toBeGreaterThanOrEqual(50);
		expect(await sliced.service.maybeRehydrateFromHistoryInSlices(history, new EventLoopSlicer())).toEqual([]);
	});
});
