import { fauxAssistantMessage, isModelConfigError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import {
	chainedHarness,
	everySink,
	fallbackLogEvents,
	lastErrorMessage,
	modelNotFound,
	persistedSessionText,
	primary,
} from "../model-config-error-harness.ts";
import { MODEL_NOT_FOUND_ANSWERS, NOT_MODEL_NOT_FOUND_ANSWERS } from "../model-not-found-inventory.ts";
import { READABLE_NAMED_VALUES, READABLE_PROVIDER_TEXT, SECRET_CELLS } from "../secret-inventory.ts";

// A gateway that does not serve a configured model id answers model_not_found. That is a configuration
// error: walking the fallback chain silently ran the turn on another provider's model.

describe("senpi#4282 model_not_found is a configuration error", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	describe("classifies the shared model-not-found inventory", () => {
		for (const [label, message] of MODEL_NOT_FOUND_ANSWERS) {
			it(`${label} is a configuration error`, () => {
				expect(isModelConfigError(message)).toBe(true);
			});
		}
		for (const [label, message] of NOT_MODEL_NOT_FOUND_ANSWERS) {
			it(`${label} is not a configuration error`, () => {
				expect(isModelConfigError(message)).toBe(false);
			});
		}
	});

	for (const [label, errorMessage] of MODEL_NOT_FOUND_ANSWERS) {
		it(`fails the turn loudly on ${label} with no retry and no fallback`, async () => {
			const harness = await chainedHarness(harnesses);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("retry answer"),
				fauxAssistantMessage("fallback answer"),
			]);

			await harness.session.prompt("hello");

			expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
			expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.session.model?.provider).toBe("faux");
			expect(harness.session.state.messages.at(-1)).toMatchObject({
				stopReason: "error",
				errorMessage,
				errorCause: { type: "model_config", model: primary },
			});
			expect(harness.eventsOfType("model_config_error")).toEqual([
				{ type: "model_config_error", model: primary, provider: "faux", errorExcerpt: errorMessage },
			]);
			expect(fallbackLogEvents(harness).filter((entry) => entry.event === "model_config_error")).toMatchObject([
				{ level: "warn", model: primary, provider: "faux", errorMessage },
			]);
		});
	}

	it("reports the configuration error once per model and session", async () => {
		const harness = await chainedHarness(harnesses);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: modelNotFound }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: modelNotFound }),
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(harness.eventsOfType("model_config_error")).toHaveLength(1);
		expect(harness.session.state.messages.at(-1)).toMatchObject({
			errorCause: { type: "model_config", model: primary },
		});
	});

	for (const [label, errorMessage] of [
		["a credential value that contains the marker", "400 Bad Request x-api-key: model_not_found=0123456789abcdef"],
		["a cookie line that runs into the marker", "400 Bad Request Cookie: a=b; unknown provider for model faux-1"],
	] as const) {
		it(`classifies on the raw body before redaction (${label})`, async () => {
			const harness = await chainedHarness(harnesses);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("retry answer"),
				fauxAssistantMessage("fallback answer"),
			]);

			await harness.session.prompt("hello");

			expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
			expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
			expect(harness.eventsOfType("model_config_error")).toHaveLength(1);
			expect(harness.session.state.messages.at(-1)).toMatchObject({ errorCause: { type: "model_config" } });
		});
	}

	it("ends the turn on a fallback model that is not served instead of trying the next rung", async () => {
		const harness = await chainedHarness(harnesses);
		const notServed = '400 {"code":"model_not_found","message":"unknown provider for model faux-2"}';
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "billing error: insufficient_quota" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: notServed }),
			fauxAssistantMessage("third rung answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.to)).toEqual(["other-faux/faux-2"]);
		expect(harness.eventsOfType("model_config_error").map((event) => event.model.split("/").at(-1))).toEqual([
			"faux-2",
		]);
		expect(harness.session.state.messages.at(-1)).toMatchObject({
			stopReason: "error",
			model: "faux-2",
			errorCause: { type: "model_config" },
		});
	});

	describe("redacts every secret shape in every container from every sink", () => {
		for (const cell of SECRET_CELLS) {
			it(cell.name, async () => {
				const harness = await chainedHarness(harnesses, { persistSession: true });
				const errorMessage = `${cell.text}\n${modelNotFound}`;
				harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

				await harness.session.prompt("hello");

				const [event] = harness.eventsOfType("model_config_error");
				expect(event?.errorExcerpt).toMatch(/\[REDACTED\]/);
				expect(event?.errorExcerpt).toContain("model_not_found");
				expect(lastErrorMessage(harness)).not.toContain(cell.secret);
				const sinks = everySink(harness);
				expect(sinks.logs).toMatch(/\[REDACTED\]/i);
				for (const [sink, text] of Object.entries(sinks)) {
					expect({ sink, leaked: text.includes(cell.secret) }).toEqual({ sink, leaked: false });
				}
			});
		}

		for (const cell of SECRET_CELLS) {
			it(`${cell.name} in an ordinary 401`, async () => {
				const harness = await createHarness({
					models: [{ id: "faux-1" }],
					persistSession: true,
					settings: { retry: { enabled: false } },
				});
				harnesses.push(harness);
				const errorMessage = `401 Unauthorized: invalid credentials ${cell.text}`;
				harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

				await harness.session.prompt("hello");

				expect(harness.eventsOfType("model_config_error")).toEqual([]);
				expect(lastErrorMessage(harness)).toContain("[REDACTED]");
				expect(lastErrorMessage(harness)).toContain("401 Unauthorized");
				for (const [sink, text] of Object.entries(everySink(harness))) {
					expect({ sink, leaked: text.includes(cell.secret) }).toEqual({ sink, leaked: false });
				}
			});
		}

		it("keeps model ids, error codes and request ids readable", async () => {
			const harness = await chainedHarness(harnesses, { persistSession: true });
			const errorMessage = `${modelNotFound} ${READABLE_PROVIDER_TEXT}`;
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

			await harness.session.prompt("hello");

			expect(harness.eventsOfType("model_config_error")).toMatchObject([{ errorExcerpt: errorMessage }]);
			expect(lastErrorMessage(harness)).toBe(errorMessage);
			expect(persistedSessionText(harness)).toContain(JSON.stringify(errorMessage).slice(1, -1));
		});

		it("keeps names that merely contain a credential word readable", async () => {
			const harness = await chainedHarness(harnesses, { persistSession: true });
			const errorMessage = `${modelNotFound} ${READABLE_NAMED_VALUES.join(" ")}`;
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

			await harness.session.prompt("hello");

			expect(lastErrorMessage(harness)).toBe(errorMessage);
			expect(persistedSessionText(harness)).toContain(JSON.stringify(errorMessage).slice(1, -1));
		});
	});
});
