import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rememberResolvedReferenceValue } from "../../../src/core/config-reference-redaction.ts";
import { createHarness, type Harness } from "../harness.ts";
import { chainedHarness, everySink, lastErrorMessage, modelNotFound } from "../model-config-error-harness.ts";

// omo#12965: provider error text that echoes a value a config reference resolved to must not reach the
// model_config_error event, the assistant message, the session file or the logs. The text flows from one handler
// into all of them, so each sink is asserted.

const SLOT_KEY = Symbol.for("@code-yeongyu/senpi/config-reference-redaction/v1");

function registrySize(): unknown {
	const slot: unknown = Reflect.get(globalThis, SLOT_KEY);
	return typeof slot === "object" && slot !== null ? Reflect.get(slot, "size") : undefined;
}

function expectNoSinkCarries(harness: Harness, secret: string): void {
	const sinks = everySink(harness);
	expect(sinks.events).not.toContain(secret);
	expect(sinks.logs).not.toContain(secret);
	expect(sinks.session).not.toContain(secret);
	expect(lastErrorMessage(harness)).not.toContain(secret);
}

describe("omo#12965 resolved values in provider error text", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps the value out of a model configuration error's event, message, session file and log", async () => {
		const secret = "resolved-12965-model-config-marker-w8";
		rememberResolvedReferenceValue(secret);
		const harness = await chainedHarness(harnesses, { persistSession: true });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: `${modelNotFound} (gateway echo: ${secret})` }),
		]);

		await harness.session.prompt("hello");

		const [reported] = harness.eventsOfType("model_config_error");
		expect(reported?.errorExcerpt).toContain("model_not_found");
		expect(reported?.errorExcerpt).toContain("[REDACTED]");
		expectNoSinkCarries(harness, secret);
	});

	it("keeps the value out of any failed turn's message and session file", async () => {
		const secret = "resolved-12965-plain-error-marker-j5";
		rememberResolvedReferenceValue(secret);
		const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: `500 upstream failed, echo: ${secret}` }),
		]);

		await harness.session.prompt("hello");

		expect(lastErrorMessage(harness)).toContain("[REDACTED]");
		expectNoSinkCarries(harness, secret);
	});

	it("never adds provider error text or a tool result to the registry", async () => {
		rememberResolvedReferenceValue("resolved-12965-registry-baseline-q1");
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "probe.txt"), "untrusted-12965-tool-text-zz");
		const before = registrySize();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 untrusted-12965-provider-text-yy" }),
		]);

		await harness.session.prompt("read the probe");

		expect(typeof before).toBe("number");
		expect(registrySize()).toBe(before);
	});
});
