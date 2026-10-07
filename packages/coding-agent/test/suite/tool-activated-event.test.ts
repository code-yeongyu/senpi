import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory, ToolActivatedEvent } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/** Registers two deferred tools and hands every `tool_activated` event to `onEvent`. */
function observer(onEvent: (event: ToolActivatedEvent) => void): ExtensionFactory {
	return (pi) => {
		for (const name of ["deferred_a", "deferred_b"]) {
			pi.registerTool({
				name,
				label: name,
				description: `Deferred fixture tool ${name}`,
				exposure: "search",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
			});
		}
		pi.on("tool_activated", (event) => onEvent(event));
	};
}

async function observedHarness(): Promise<{ harness: Harness; events: ToolActivatedEvent[] }> {
	const events: ToolActivatedEvent[] = [];
	const harness = await createHarness({ extensionFactories: [observer((event) => events.push(event))] });
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	events.length = 0;
	return { harness, events };
}

describe("tool_activated extension event (senpi#2128)", () => {
	it("reports only the tools that became active", async () => {
		// Given
		const { harness, events } = await observedHarness();
		const before = harness.session.getActiveToolNames();

		// When
		harness.session.setActiveToolsByName([...before, "deferred_a"]);

		// Then
		expect(events).toEqual([{ type: "tool_activated", toolNames: ["deferred_a"] }]);
	});

	it("stays silent when the active set gains nothing", async () => {
		// Given
		const { harness, events } = await observedHarness();
		const withA = [...harness.session.getActiveToolNames(), "deferred_a"];
		harness.session.setActiveToolsByName(withA);
		events.length = 0;

		// When
		harness.session.setActiveToolsByName(withA.filter((name) => name !== "deferred_a"));

		// Then
		expect(events).toEqual([]);
	});
});
