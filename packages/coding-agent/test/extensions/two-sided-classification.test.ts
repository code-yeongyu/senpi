// S29 (brain/hand split, C7(c)): which extensions are two-sided. The rule is read from the event placement table, so
// every loop or split event counts, and an event added to the table later is classified without touching S29.
import { describe, expect, it } from "vitest";
import { EXTENSION_EVENT_PLACEMENT } from "../../src/core/extensions/event-placement.ts";
import { twoSidedExtensions } from "../../src/core/extensions/two-sided-forwarding.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createTestExtensionsResult } from "../utilities.ts";

type On = (event: string, handler: () => undefined, options?: { runs: "brain" | "hand" }) => void;
const on = (pi: ExtensionAPI): On => pi.on.bind(pi) as unknown as On;

async function classify(factory: ExtensionFactory): Promise<boolean> {
	const { extensions } = await createTestExtensionsResult([{ factory, path: "/ext/probe.ts" }]);
	return twoSidedExtensions(extensions).has("/ext/probe.ts");
}

const pairedEvents = Object.entries(EXTENSION_EVENT_PLACEMENT).filter(
	([event]) => event !== "tool_call" && event !== "tool_result",
);

describe("two-sided classification follows the event placement (S29)", () => {
	it.each(pairedEvents)("%s (%s) paired with an undeclared tool_call", async (event, placement) => {
		const twoSided = await classify((pi) => {
			on(pi)(event, () => undefined);
			on(pi)("tool_call", () => undefined);
		});

		expect(twoSided).toBe(placement !== "runtime");
	});

	it.each(["tool_call", "tool_result"])("an undeclared %s pairs with a loop event", async (toolEvent) => {
		expect(
			await classify((pi) => {
				on(pi)("model_select", () => undefined);
				on(pi)(toolEvent, () => undefined);
			}),
		).toBe(true);
	});

	it("declared handlers do not make an extension two-sided", async () => {
		expect(
			await classify((pi) => {
				on(pi)("model_select", () => undefined, { runs: "brain" });
				on(pi)("tool_call", () => undefined);
			}),
		).toBe(false);
		expect(
			await classify((pi) => {
				on(pi)("model_select", () => undefined);
				on(pi)("tool_call", () => undefined, { runs: "hand" });
			}),
		).toBe(false);
	});
});
