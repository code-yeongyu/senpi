import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

const RECOVERY_FAILURES = [
	["text_tool_call_recovery_invalid_content_event", "Invalid assistant content event order"],
	["text_tool_call_recovery_invalid_native_event", "Invalid native tool call event order"],
	["text_tool_call_recovery_collision", "Tool call ID collision in provider stream"],
] as const;

function recoveryFailure(diagnosticType: string, errorMessage: string): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		diagnostics: [{ type: diagnosticType, timestamp: 0, details: { protocol: "hermes", status: "failed" } }],
	};
}

describe("a tool-call recovery stream failure never switches models (senpi#5723)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function sessionWithFallback(maxRetries: number): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["other-faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		return harness;
	}

	it.each(RECOVERY_FAILURES)("keeps the model after %s", async (diagnosticType, errorMessage) => {
		const harness = await sessionWithFallback(0);
		harness.setResponses([
			recoveryFailure(diagnosticType, errorMessage),
			fauxAssistantMessage("must not be requested"),
		]);

		await harness.session.prompt("write the file");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(`${harness.session.model?.provider}/${harness.session.model?.id}`).toBe("faux/faux-1");
		expect(harness.session.messages.findLast((message) => message.role === "assistant")).toMatchObject({
			stopReason: "error",
			errorMessage,
		});
	});

	it("still falls back when the provider itself fails (control)", async () => {
		const harness = await sessionWithFallback(0);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "billing error: insufficient_quota" }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(1);
	});
});
