import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProviderRetryDelayError,
	retryProviderRequest,
	retryProviderStreamRequest,
} from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("forwards early consumer cancellation to the provider stream", async () => {
		const closeStream = vi.fn(async () => ({ done: true as const, value: undefined }));
		const iterator: AsyncIterator<string> = {
			next: vi.fn(async () => ({ done: false as const, value: "first" })),
			return: closeStream,
		};
		const attempt = await retryProviderStreamRequest(
			async () => ({
				stream: { [Symbol.asyncIterator]: () => iterator },
				metadata: "response",
			}),
			{ maxRetries: 1 },
		);

		for await (const chunk of attempt.stream) {
			expect(chunk).toBe("first");
			break;
		}

		expect(closeStream).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Structured hint propagation (todo 4)
// ---------------------------------------------------------------------------

describe("structured retry-after hint propagation", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stamps retryAfterMs and canonical marker on over-cap 429 with retry-after header", async () => {
		// Observed live: ccapi 429 with `retry-after: 1258`, default 60s cap.
		// The thrown error must carry the structured numeric property so the
		// orchestration layer can recover the full server delay without re-parsing.
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "1258" }));

		const promise = retryProviderRequest(request, { maxRetries: 1 });

		let caught: unknown;
		try {
			await promise;
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		const err = caught as ProviderRetryDelayError;
		expect(err.retryAfterMs).toBe(1_258_000);
		expect(err.message).toContain("(retry-after-ms: 1258000)");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("honors retry-after: 2 header delay under cap with fake timers", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		// Should sleep ~2000ms honoring the header, not the exponential fallback.
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1); // not retried yet
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("honors retry-after-ms header on non-429 (500) errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(500, { "retry-after-ms": "100" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		// Should sleep ~100ms honoring the header, not the ~1000ms exponential fallback.
		await vi.advanceTimersByTimeAsync(99);
		expect(request).toHaveBeenCalledTimes(1); // not retried yet
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("uses exponential path for non-429 (500) errors — characterization pin", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(500, {}))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		// Exponential delay for retryIndex 0: min(0.5 * 2^0, 8) * 1000 = 500ms,
		// with jitter (1 - random*0.25) so range is [375, 500]ms.
		// Advancing 374ms should NOT trigger retry; 500ms will.
		await vi.advanceTimersByTimeAsync(374);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(500); // well past the max possible delay
		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("preserves exponential fallback for 429 without any hint", async () => {
		vi.useFakeTimers();
		// 429 with no retry-after headers at all — must use exponential, not 0.
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, {}))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		// extract429RetryAfterMs returns undefined (no hint), exponential fallback
		// fires: min(0.5*2^0, 8)*1000 = 500ms with jitter [375, 500].
		// Zero ms would mean it retried immediately — that must NOT happen.
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1); // no immediate retry
		await vi.advanceTimersByTimeAsync(500);
		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("honors x-should-retry: true header (characterization pin)", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(400, { "x-should-retry": "true" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(500);
		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("handles malformed retry-after headers gracefully (falls through to exponential)", async () => {
		vi.useFakeTimers();
		// Garbage retry-after that extract429RetryAfterMs cannot parse -> undefined,
		// so exponential fallback kicks in.
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "garbage-later" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		// Exponential: ~500ms with jitter. Should NOT sleep for a huge value.
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(500);
		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("preserves DigitalOcean stream failure special-case", async () => {
		vi.useFakeTimers();
		const doError = Object.assign(new Error("Upstream error from DigitalOcean: stream failed"), {
			status: undefined,
			headers: undefined,
		});
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(doError).mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(500);
		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("stamps retryAfterMs when retry-after-ms header exceeds cap", async () => {
		// retry-after-ms: 90000 with default 60s cap -> over-cap error
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(providerError(429, { "retry-after-ms": "90000" }));

		const promise = retryProviderRequest(request, { maxRetries: 1 });

		let caught: unknown;
		try {
			await promise;
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		const err = caught as ProviderRetryDelayError;
		expect(err.retryAfterMs).toBe(90_000);
		expect(err.message).toContain("(retry-after-ms: 90000)");
	});
});
