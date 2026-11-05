import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#5518: a Claude subscription session whose rungs all fail fell back onto the Anthropic API-key
// provider and billed an account the user had not selected. A bare rung stays on the session's provider.
const crashed = () =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "Claude Code process exited with code 1" });

describe("senpi#5518: fallback never leaves the session's provider", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		{ selected: "anthropic-subscription", other: "anthropic" },
		{ selected: "anthropic", other: "anthropic-subscription" },
	])("a $selected session never sends a fallback request to $other", async ({ selected, other }) => {
		const harness = await createHarness({
			provider: selected,
			models: [{ id: "claude-opus-5-5" }, { id: "claude-opus-5" }],
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		registerFallbackModels(harness, other, ["claude-opus-5-5", "claude-opus-5"]);
		harness.setResponses([crashed(), crashed(), crashed()]);

		await harness.session.prompt("hi");

		const hops = harness.eventsOfType("retry_fallback_applied").map((event) => event.to);
		expect(hops).toEqual([`${selected}/claude-opus-5`]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["claude-opus-5-5", "claude-opus-5"]);
	});
});
