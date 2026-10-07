import { describeReplacedInstall, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { visibleErrorLines } from "../stream-start-stall-support.ts";

/**
 * senpi#2358: after a package manager replaced the install under a running session, the first
 * lazily imported provider module was gone, the session walked the whole fallback chain into the
 * same missing module, and every later request failed the same way. The failure now ends the turn
 * once, with a restart notice and no retry or fallback.
 */
const MISSING = new Error(
	"Cannot find module './anthropic-messages-UYDVRFAS.js' from '/g/node_modules/@code-yeongyu/senpi/dist/bundle/chunks/chunk-T3JBT2IK.js'",
);

describe("a provider module removed by a reinstall (senpi#2358)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("ends the turn with one restart notice instead of walking the fallback chain", async () => {
		// Given
		const errorMessage = describeReplacedInstall(MISSING);
		if (!errorMessage) throw new Error("the missing chunk was not classified");
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, fallbackChains: { "faux/faux-1": ["faux/faux-2"] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			fauxAssistantMessage("must not run"),
		]);
		// When
		await harness.session.prompt("hello");
		await harness.session.waitForIdle();
		// Then
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		const lines = visibleErrorLines(harness).join("\n");
		expect(lines).toContain("anthropic-messages-UYDVRFAS.js can no longer be loaded");
		expect(lines).toContain("Restart and resume this session");
		expect(lines).not.toContain("senpi:no-turn-retry:");
	});
});
