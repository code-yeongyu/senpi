import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

type ContinuationInternals = {
	_isAgentRunActive: boolean;
	_retryPromise: Promise<void> | undefined;
	_revalidateScheduledContinuationAdmission(): Promise<void>;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

async function settleWithin<T>(promise: Promise<T>, label: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutFailure = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000);
	});
	try {
		return await Promise.race([promise, timeoutFailure]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

describe("retry fallback continuation revalidation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("settles a fallback retry when continuation admission rejects before agent.continue", async () => {
		const providerStarted = createDeferred();
		const releaseProvider = createDeferred();
		const revalidationError = new Error("fallback model/context admission rejected");
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as ContinuationInternals;
		const revalidate = vi
			.spyOn(internals, "_revalidateScheduledContinuationAdmission")
			.mockRejectedValue(revalidationError);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");
		const continuationError = new Promise<string>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "continuation_error") resolve(event.errorMessage);
			});
		});
		harness.setResponses([
			async () => {
				providerStarted.resolve();
				await releaseProvider.promise;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
			},
			fauxAssistantMessage("fallback provider must not run"),
		]);

		const prompt = harness.session.prompt("retry fallback continuation admission");
		await providerStarted.promise;
		await harness.session.followUp("retain queued fallback continuation");
		releaseProvider.resolve();

		const [promptResult, terminalError] = await settleWithin(
			Promise.all([prompt, continuationError]),
			"fallback continuation terminal settlement",
		);

		expect(promptResult).toBeUndefined();
		expect(revalidate).toHaveBeenCalledTimes(1);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(terminalError).toBe("Failed to continue queued messages: fallback model/context admission rejected");
		expect(internals._isAgentRunActive).toBe(false);
		expect(internals._retryPromise).toBeUndefined();
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual(["retain queued fallback continuation"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
