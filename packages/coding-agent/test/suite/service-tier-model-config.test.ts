import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("session service tier from model configuration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("falls back to the model's configured serviceTier for the initial model", async () => {
		const harness = await createHarness({ serviceTier: "priority" });
		harnesses.push(harness);

		expect(harness.session.serviceTier).toBe("priority");
	});

	it("applies the configured serviceTier after switching back to the model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
			serviceTier: "priority",
		});
		harnesses.push(harness);

		const other = harness.getModel("faux-2");
		expect(other).toBeDefined();
		await harness.session.setModel(other!);
		expect(harness.session.serviceTier).toBeUndefined();

		const primary = harness.getModel("faux-1");
		expect(primary).toBeDefined();
		await harness.session.setModel(primary!);
		expect(harness.session.serviceTier).toBe("priority");
	});
});
