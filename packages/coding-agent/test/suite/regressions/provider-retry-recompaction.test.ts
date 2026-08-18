import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_START_TIMEOUT_MS = 90_000;

type ContinuationInternals = {
	_scheduledContinuationRecompacted: boolean;
	_revalidateScheduledContinuationAdmission(): Promise<void>;
};

function genericTimeoutError() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "Request timed out.",
	});
}

function getRequestUserTexts(harness: Harness): string[][] {
	return harness.faux
		.getCallLog()
		.map((call) =>
			call.context.messages.filter((message) => message.role === "user").map((message) => getMessageText(message)),
		);
}

function getStreamStartTimeoutMs(options: unknown): number | undefined {
	if (!options || typeof options !== "object" || !("streamStartTimeoutMs" in options)) return undefined;
	const value = (options as { streamStartTimeoutMs?: unknown }).streamStartTimeoutMs;
	return typeof value === "number" ? value : undefined;
}

describe("provider retry recompaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each([
		["assistant", "queued"],
		["assistant", "empty"],
		["non-assistant", "queued"],
		["non-assistant", "empty"],
	] as const)(
		"keeps timeout retries queue-first after recompaction with a %s tail and %s queue",
		async (tail, queueState) => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
			});
			harnesses.push(harness);
			harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
			harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
			const internals = harness.session as unknown as ContinuationInternals;
			vi.spyOn(internals, "_revalidateScheduledContinuationAdmission").mockImplementation(async () => {
				internals._scheduledContinuationRecompacted = true;
				if (tail === "assistant") {
					harness.agent.state.messages = [
						...harness.agent.state.messages,
						fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." }),
					];
					return;
				}
				harness.agent.state.messages = [
					...harness.agent.state.messages,
					{
						role: "custom",
						customType: "compactionSummary",
						content: "accepted retry compaction summary",
						display: false,
						timestamp: Date.now(),
					},
				];
			});
			const queueAwareContinue = vi.spyOn(harness.agent, "continueWithQueuedMessages");
			let queuedInput: Promise<void> | undefined;
			harness.session.subscribe((event) => {
				if (queueState === "queued" && event.type === "auto_retry_start" && queuedInput === undefined) {
					queuedInput = harness.session.steer("queued after timeout");
				}
			});
			harness.setResponses([
				genericTimeoutError(),
				fauxAssistantMessage("recovered after recompaction"),
				fauxAssistantMessage("must not run"),
			]);

			await harness.session.prompt("original request");
			await queuedInput;

			expect(queueAwareContinue).toHaveBeenCalledTimes(1);
			expect(harness.eventsOfType("continuation_error")).toEqual([]);
			const retryUserTexts = [
				"original request",
				...(tail === "non-assistant" ? ["accepted retry compaction summary"] : []),
				...(queueState === "queued" ? ["queued after timeout"] : []),
			];
			expect(getRequestUserTexts(harness)).toEqual([["original request"], retryUserTexts]);
			expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([
				DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
				DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			]);
			expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
				DEFAULT_STREAM_START_TIMEOUT_MS,
				DEFAULT_STREAM_START_TIMEOUT_MS,
			]);
		},
	);
});
