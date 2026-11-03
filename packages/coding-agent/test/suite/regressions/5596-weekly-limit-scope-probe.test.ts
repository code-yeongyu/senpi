import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const START = Date.UTC(2026, 10, 3, 0, 24);
// A weekly limit worded without the model family it binds.
const WEEKLY =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"Weekly usage limit reached. Resets at 2026-11-03T02:40:02Z"}}';

describe("#5596 a limit that names no model family probes another family once", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	async function session() {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "claude-fable-5-1" }, { id: "claude-opus-5-5" }],
			fallbackNow: () => now,
			fallbackWallNow: () => START + now,
			settings: {
				compaction: { enabled: false },
				retry: {
					enabled: true,
					maxRetries: 0,
					fallbackChains: { "faux/claude-fable-5-1": ["faux/claude-opus-5-5"] },
				},
			},
		});
		harnesses.push(harness);
		return { harness, tick: (ms: number) => (now += ms) };
	}

	it("holds only the failing family and lets the other family serve", async () => {
		const { harness } = await session();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: WEEKLY }),
			fauxAssistantMessage("served by opus"),
		]);

		await harness.session.prompt("first");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["claude-fable-5-1", "claude-opus-5-5"]);
		expect(harness.eventsOfType("usage_limit_scope_probe")).toMatchObject([
			{ provider: "faux", heldFamily: "fable", probeFamily: "opus", outcome: "served" },
		]);
	});

	it("never lets an automated loop hammer the held family when no other family can probe", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "claude-fable-5-1" }],
			fallbackNow: () => now,
			fallbackWallNow: () => START + now,
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: WEEKLY })]);
		await harness.session.prompt("first");

		now += 60_000;
		const refusal = harness.session.prompt("goal continuation", { source: "extension" });

		await expect(refusal).rejects.toMatchObject({ name: "AccountUsageLimitError" });
		await expect(refusal).rejects.toThrow(/fable/);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("widens to the account only when the other family is limited too, naming both", async () => {
		const { harness, tick } = await session();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: WEEKLY }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: WEEKLY }),
		]);
		await harness.session.prompt("first");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["claude-fable-5-1", "claude-opus-5-5"]);
		expect(harness.eventsOfType("usage_limit_scope_probe")).toMatchObject([
			{ provider: "faux", heldFamily: "fable", probeFamily: "opus", outcome: "widened" },
		]);

		tick(60_000);
		const refusal = harness.session.prompt("goal continuation", { source: "extension" });

		await expect(refusal).rejects.toMatchObject({ name: "AccountUsageLimitError" });
		await expect(refusal).rejects.toThrow(/fable.*opus|opus.*fable/);
		expect(harness.faux.getCallLog()).toHaveLength(2);
	});
});
