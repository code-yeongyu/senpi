import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

// The three ways the text tool-call recovery stream ends a turn (packages/ai
// tool-call-middleware/recovery-stream-failure.ts). Each is a defect in our own
// stream recovery, so another model cannot fix it (senpi#5723).
const recoveryFailures = [
	{
		diagnosticType: "text_tool_call_recovery_invalid_content_event",
		errorMessage: "Invalid assistant content event order",
		status: "invalid_content_event_order",
	},
	{
		diagnosticType: "text_tool_call_recovery_collision",
		errorMessage: "Tool call ID collision in provider stream",
		status: "collision",
	},
	{
		diagnosticType: "text_tool_call_recovery_invalid_native_event",
		errorMessage: "Invalid native tool call event order",
		status: "invalid_native_event_order",
	},
] as const;

function recoveryFailureMessage(failure: (typeof recoveryFailures)[number]): AssistantMessage {
	return {
		...fauxAssistantMessage("partial answer", { stopReason: "error", errorMessage: failure.errorMessage }),
		diagnostics: [
			{ type: failure.diagnosticType, timestamp: 1, details: { protocol: "anthropic-xml", status: failure.status } },
		],
	};
}

describe("retry fallback on tool-call recovery stream failures (senpi#5723)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function chainedHarness(): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		return harness;
	}

	it.each(recoveryFailures)("ends the turn on $diagnosticType without a model fallback", async (failure) => {
		const harness = await chainedHarness();
		harness.setResponses([recoveryFailureMessage(failure), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.state.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: failure.errorMessage,
		});
	});
});
