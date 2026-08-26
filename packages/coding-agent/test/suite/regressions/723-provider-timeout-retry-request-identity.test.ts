import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const STREAM_START_STALL_ERROR = "Provider stream start timed out after 90000ms";

function summarizeMessages(messages: unknown[]) {
	return messages.map((message) => {
		if (!message || typeof message !== "object") {
			return { shape: typeof message, value: message };
		}
		const record = message as {
			role?: string;
			stopReason?: string;
			errorMessage?: string;
			timestamp?: number;
			content?: unknown;
		};
		return {
			role: record.role,
			text: getMessageText(message),
			stopReason: record.stopReason,
			errorMessage: record.errorMessage,
			timestamp: record.timestamp,
			keys: Object.keys(record).sort(),
			content: record.content,
		};
	});
}

function describeUnknown(value: unknown): unknown {
	if (value === undefined) return { type: "undefined" };
	if (value === null) return { type: "null" };
	if (typeof value === "function") return { type: "function", name: value.name };
	if (typeof value !== "object") return { type: typeof value, value };
	if (value instanceof AbortSignal) {
		return { type: "AbortSignal", aborted: value.aborted };
	}
	if (Array.isArray(value)) return { type: "array", length: value.length };
	return { type: "object", keys: Object.keys(value).sort() };
}

function describeOptions(options: unknown) {
	if (!options || typeof options !== "object") return options;
	const record = options as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(record)
			.sort()
			.map((key) => [key, describeUnknown(record[key])]),
	);
}

describe("issue #723 provider timeout retry request identity", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retries a stream-start stall with the same provider request messages", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("seed-one"),
			fauxAssistantMessage("seed-two"),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: STREAM_START_STALL_ERROR,
			}),
			fauxAssistantMessage("recovered after stall"),
		]);

		await harness.session.prompt("seed one");
		await harness.session.prompt("seed two");
		await harness.session.prompt("trigger stall");

		const calls = harness.faux.getCallLog();
		expect(harness.faux.state.callCount).toBe(4);
		expect(calls).toHaveLength(4);
		expect(
			harness.eventsOfType("auto_retry_start").map((event) => ({
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			})),
		).toEqual([
			{
				attempt: 1,
				maxAttempts: 2,
				delayMs: 0,
				errorMessage: STREAM_START_STALL_ERROR,
			},
		]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);

		const failed = calls[2];
		const retried = calls[3];
		const failedMessages = failed.context.messages;
		const retriedMessages = retried.context.messages;

		// Discovery dump: print failed vs retried arrays (and next-layer options) before identity.
		console.log("=== #723 failed vs retried request messages ===");
		console.log("failed.length", failedMessages.length, "retried.length", retriedMessages.length);
		console.log("failed.summaries", JSON.stringify(summarizeMessages(failedMessages), null, 2));
		console.log("retried.summaries", JSON.stringify(summarizeMessages(retriedMessages), null, 2));
		console.log("failed.raw", JSON.stringify(failedMessages, null, 2));
		console.log("retried.raw", JSON.stringify(retriedMessages, null, 2));
		console.log("failed.options", JSON.stringify(describeOptions(failed.options), null, 2));
		console.log("retried.options", JSON.stringify(describeOptions(retried.options), null, 2));
		console.log("call.timestamps", failed.timestamp, retried.timestamp);

		expect(retriedMessages).toEqual(failedMessages);
	});
});
