import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import type { Settings } from "../../src/core/settings-manager.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

function fallbackLogLines(harness: Harness): Array<Record<string, unknown>> {
	const logPath = join(harness.tempDir, "agent", "logs", "fallback.log");
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const parsed: Record<string, unknown> = JSON.parse(line);
			return parsed;
		});
}

describe("retry fallback hardening", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("logs a startup validation warning for malformed raw chain config", async () => {
		const retrySettings: Partial<Settings> = JSON.parse(
			`{"retry":{"enabled":true,"fallbackChains":{"${primary}":"not-an-array"}}}`,
		);
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: retrySettings,
		});
		harnesses.push(harness);

		const warnings = fallbackLogLines(harness).filter((line) => line.event === "validation_warning");
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("refuses a self-referential-only chain and logs the exhaustion decision", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, baseDelayMs: 1, maxRetries: 1, fallbackChains: { [primary]: [primary] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), overloaded()]);

		await harness.session.prompt("self chain");

		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(0);
		expect(harness.session.model?.id).toBe("faux-1");
		const events = fallbackLogLines(harness).map((line) => line.event);
		expect(events).toContain("candidates_exhausted");
	});

	it("skips a self-referential entry and lands on the next candidate", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [primary, fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("self first");

		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(1);
		expect(harness.faux.getCallLog()[1]?.modelId).toBe("faux-2");
	});


	it("submits a clean full request for a responses-API fallback candidate", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			api: "openai-responses",
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("responses api fallback");

		const fallbackRequest = harness.faux.getCallLog()[1];
		if (!fallbackRequest) throw new Error("missing fallback request");
		expect(fallbackRequest.modelId).toBe("faux-2");
		expect(fallbackRequest.options).not.toHaveProperty("previous_response_id");
		expect(JSON.stringify(fallbackRequest.context.messages)).toContain("responses api fallback");
	});

	it("logs the no-chain decision for an unconfigured model", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("no chain here");

		const events = fallbackLogLines(harness).map((line) => line.event);
		expect(events).toContain("no_chain");
	});
});
