import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../harness.ts";
import { chainedHarness, everySink, lastErrorMessage, modelNotFound, primary } from "../model-config-error-harness.ts";
import { SECRET_CELLS } from "../secret-inventory.ts";

// senpi#4282: a provider error the stream function throws never passes the provider stream boundary, so the agent
// classifies and redacts it itself. Before, a thrown model_not_found retried and walked the fallback chain, and its raw
// body reached every sink.

function throwFirstAttempt(harness: Harness, errorMessage: string): string[] {
	const attempts: string[] = [];
	harness.agent.streamFunction = (model, context, options) => {
		attempts.push(`${model.provider}/${model.id}`);
		if (attempts.length === 1) throw new Error(errorMessage);
		return streamSimple(model, context, options);
	};
	return attempts;
}

describe("senpi#4282 thrown provider errors", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("fails the turn loudly on a thrown model_not_found with no retry and no fallback", async () => {
		const harness = await chainedHarness(harnesses);
		const attempts = throwFirstAttempt(harness, modelNotFound);
		harness.setResponses([fauxAssistantMessage("retry answer"), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		expect(attempts).toEqual([primary]);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.session.state.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorCause: { type: "model_config", model: primary },
		});
		expect(harness.eventsOfType("model_config_error")).toEqual([
			{ type: "model_config_error", model: primary, provider: "faux", errorExcerpt: modelNotFound },
		]);
	});

	describe("redacts every secret shape a thrown error carries from every sink", () => {
		for (const cell of SECRET_CELLS) {
			it(cell.name, async () => {
				const harness = await chainedHarness(harnesses, { persistSession: true });
				throwFirstAttempt(harness, `${cell.text}\n${modelNotFound}`);

				await harness.session.prompt("hello");

				expect(harness.eventsOfType("model_config_error")).toHaveLength(1);
				expect(lastErrorMessage(harness)).toContain("[REDACTED]");
				for (const [sink, text] of Object.entries(everySink(harness))) {
					expect({ sink, leaked: text.includes(cell.secret) }).toEqual({ sink, leaked: false });
				}
			});
		}
	});
});
