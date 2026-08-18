import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_START_TIMEOUT_MS = 90_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function idleTimeoutError() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: `Idle timeout waiting for provider stream after ${DEFAULT_PROVIDER_IDLE_TIMEOUT_MS}ms`,
	});
}

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

describe("provider idle steering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("preserves steering until the timed-out retry recovers under configured timeouts", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		harness.setResponses([
			idleTimeoutError(),
			genericTimeoutError(),
			fauxAssistantMessage("original request recovered"),
			fauxAssistantMessage("steering request recovered"),
		]);

		let queuedSteering: Promise<void> | undefined;
		let resolveSteeringResponse: (() => void) | undefined;
		const steeringResponse = new Promise<void>((resolve) => {
			resolveSteeringResponse = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && queuedSteering === undefined) {
				queuedSteering = harness.session.steer("continue");
			}
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				getMessageText(event.message) === "steering request recovered"
			) {
				resolveSteeringResponse?.();
			}
		});

		try {
			await harness.session.prompt("original request");
			await queuedSteering;
			await withTimeout(
				steeringResponse,
				1_000,
				`queued steering response was not produced: ${JSON.stringify(getRequestUserTexts(harness))}`,
			);
			await withTimeout(
				steeringResponse,
				1_000,
				`queued steering response was not produced: ${JSON.stringify(getRequestUserTexts(harness))}`,
			);
		} finally {
			unsubscribe();
		}

		expect(getRequestUserTexts(harness)).toEqual([
			["original request"],
			["original request"],
			["original request"],
			["original request", "continue"],
		]);
		expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
		]);
		expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
			DEFAULT_STREAM_START_TIMEOUT_MS,
			DEFAULT_STREAM_START_TIMEOUT_MS,
			DEFAULT_STREAM_START_TIMEOUT_MS,
			DEFAULT_STREAM_START_TIMEOUT_MS,
		]);
		expect(getUserTexts(harness)).toEqual(["original request", "continue"]);
	});

	it("runs queued steering after the timed-out retry budget is exhausted", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		harness.setResponses([
			idleTimeoutError(),
			idleTimeoutError(),
			fauxAssistantMessage("steering request recovered after retry exhaustion"),
		]);

		let queuedSteering: Promise<void> | undefined;
		let resolveSteeringResponse: (() => void) | undefined;
		const steeringResponse = new Promise<void>((resolve) => {
			resolveSteeringResponse = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && queuedSteering === undefined) {
				queuedSteering = harness.session.steer("continue after exhausted retry");
			}
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				getMessageText(event.message) === "steering request recovered after retry exhaustion"
			) {
				resolveSteeringResponse?.();
			}
		});

		try {
			await harness.session.prompt("original request");
			await queuedSteering;
			await withTimeout(
				steeringResponse,
				1_000,
				`queued steering response was not produced after retry exhaustion: ${JSON.stringify(
					getRequestUserTexts(harness),
				)}`,
			);
		} finally {
			unsubscribe();
		}

		expect(getRequestUserTexts(harness)).toEqual([
			["original request"],
			["original request"],
			["original request", "continue after exhausted retry"],
		]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.agent.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["original request", "continue after exhausted retry"]);
	});

	it("uses the retry continuation's queue ownership when the final error changes class", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		harness.setResponses([
			idleTimeoutError(),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("mixed-error steering recovered"),
		]);

		let queuedSteering: Promise<void> | undefined;
		let resolveSteeringResponse: (() => void) | undefined;
		const steeringResponse = new Promise<void>((resolve) => {
			resolveSteeringResponse = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && queuedSteering === undefined) {
				queuedSteering = harness.session.steer("continue after mixed-error exhaustion");
			}
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				getMessageText(event.message) === "mixed-error steering recovered"
			) {
				resolveSteeringResponse?.();
			}
		});

		try {
			await harness.session.prompt("original request");
			await queuedSteering;
			await withTimeout(
				steeringResponse,
				1_000,
				`mixed-error retry lost queue ownership: ${JSON.stringify(getRequestUserTexts(harness))}`,
			);
			await withTimeout(
				steeringResponse,
				1_000,
				`mixed-error retry lost queue ownership: ${JSON.stringify(getRequestUserTexts(harness))}`,
			);
		} finally {
			unsubscribe();
		}

		expect(getRequestUserTexts(harness)).toEqual([
			["original request"],
			["original request"],
			["original request", "continue after mixed-error exhaustion"],
		]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.agent.hasQueuedMessages()).toBe(false);
	});

	it("keeps late steering parked when a non-deferred retry ends in a provider timeout", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		const retryRequestStarted = createDeferred();
		const releaseRetryResponse = createDeferred();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			async () => {
				retryRequestStarted.resolve();
				await releaseRetryResponse.promise;
				return idleTimeoutError();
			},
			fauxAssistantMessage("must not run"),
		]);

		const prompt = harness.session.prompt("original request");
		await retryRequestStarted.promise;
		await harness.session.steer("late steering after retry poll");
		releaseRetryResponse.resolve();
		await prompt;
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getSteeringMessages()).toEqual(["late steering after retry poll"]);
		expect(harness.agent.hasQueuedMessages()).toBe(true);
	});

	it("retains queued steering when the user aborts during retry backoff", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([idleTimeoutError(), idleTimeoutError(), fauxAssistantMessage("must not run")]);

		let queuedSteering: Promise<void> | undefined;
		let abortDuringBackoff: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type !== "auto_retry_start" || event.attempt !== 2 || queuedSteering !== undefined) return;
			queuedSteering = harness.session.steer("parked through retry backoff abort");
			abortDuringBackoff = queuedSteering.then(async () => {
				await harness.session.abort();
			});
		});

		await harness.session.prompt("original request");
		await queuedSteering;
		await abortDuringBackoff;
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getSteeringMessages()).toEqual(["parked through retry backoff abort"]);
		expect(harness.agent.hasQueuedMessages()).toBe(true);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("retains queued input when a bounded retry is aborted in flight", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		const retryRequestStarted = createDeferred();
		let queuedInput: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && queuedInput === undefined) {
				queuedInput = harness.session.steer("retain through retry abort");
			}
		});
		harness.setResponses([
			genericTimeoutError(),
			async (_context, options) => {
				retryRequestStarted.resolve();
				await new Promise<void>((resolve) => {
					const signal = options?.signal;
					if (signal?.aborted) {
						resolve();
						return;
					}
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" });
			},
			fauxAssistantMessage("must not run"),
		]);

		const prompt = harness.session.prompt("original request");
		await retryRequestStarted.promise;
		await queuedInput;
		await harness.session.abort();
		await prompt;
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.faux.getCallLog()[1]?.options?.timeoutMs).toBe(DEFAULT_PROVIDER_IDLE_TIMEOUT_MS);
		expect(harness.session.getSteeringMessages()).toEqual(["retain through retry abort"]);
		expect(harness.agent.hasQueuedMessages()).toBe(true);
		expect(harness.eventsOfType("continuation_error")).toEqual([]);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.agent.state.isStreaming).toBe(false);
	});
});
