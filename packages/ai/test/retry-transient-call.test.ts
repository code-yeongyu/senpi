import { describe, expect, it, vi } from "vitest";
import { type RetryPolicy, retryTransientCall } from "../src/utils/retry.ts";

/**
 * `retryTransientCall` is the throw-based sibling of `retryAssistantCall`: it
 * owns the same bounded backoff, abort, and callback semantics for producers
 * that signal failure by throwing instead of returning an error-stopped
 * `AssistantMessage`. Compaction summarization is the first consumer.
 */
describe("retryTransientCall", () => {
	const enabled: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };
	const disabled: RetryPolicy = { enabled: false, maxRetries: 3, baseDelayMs: 0 };
	const alwaysRetryable = () => true;

	it("returns the value immediately when the producer succeeds", async () => {
		const produce = vi.fn(async () => "ok");
		const onRetryScheduled = vi.fn();
		await expect(
			retryTransientCall(produce, alwaysRetryable, enabled, undefined, { onRetryScheduled }),
		).resolves.toBe("ok");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it("retries a retryable throw until it succeeds", async () => {
		let attempts = 0;
		const produce = vi.fn(async () => {
			attempts++;
			if (attempts < 3) throw new Error("500 Worker exceeded memory limit.");
			return "recovered";
		});
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		await expect(
			retryTransientCall(produce, alwaysRetryable, enabled, undefined, { onRetryScheduled, onRetryFinished }),
		).resolves.toBe("recovered");
		expect(produce).toHaveBeenCalledTimes(3);
		expect(onRetryScheduled).toHaveBeenCalledTimes(2);
		expect(onRetryFinished).toHaveBeenCalledWith(true, 2);
	});

	it("rethrows the final error once the retry budget is exhausted", async () => {
		const produce = vi.fn(async () => {
			throw new Error("500 Worker exceeded memory limit.");
		});
		const onRetryFinished = vi.fn();
		await expect(
			retryTransientCall(produce, alwaysRetryable, enabled, undefined, { onRetryFinished }),
		).rejects.toThrow("500 Worker exceeded memory limit.");
		expect(produce).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
		expect(onRetryFinished).toHaveBeenCalledWith(false, 3, "500 Worker exceeded memory limit.");
	});

	it("never retries a non-retryable throw", async () => {
		const produce = vi.fn(async () => {
			throw new TypeError("cannot read properties of undefined");
		});
		const onRetryScheduled = vi.fn();
		await expect(retryTransientCall(produce, () => false, enabled, undefined, { onRetryScheduled })).rejects.toThrow(
			TypeError,
		);
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it("passes the thrown error to the classifier", async () => {
		const seen: unknown[] = [];
		const produce = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(
			retryTransientCall(
				produce,
				(error) => {
					seen.push(error);
					return false;
				},
				enabled,
				undefined,
			),
		).rejects.toThrow("boom");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeInstanceOf(Error);
	});

	it("runs the producer once when the policy is disabled", async () => {
		const produce = vi.fn(async () => {
			throw new Error("500 Worker exceeded memory limit.");
		});
		await expect(retryTransientCall(produce, alwaysRetryable, disabled, undefined, {})).rejects.toThrow(
			"500 Worker exceeded memory limit.",
		);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("runs the producer once when no policy is supplied", async () => {
		const produce = vi.fn(async () => {
			throw new Error("500 Worker exceeded memory limit.");
		});
		await expect(retryTransientCall(produce, alwaysRetryable, undefined, undefined)).rejects.toThrow(
			"500 Worker exceeded memory limit.",
		);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("emits onRetryAttemptStart after the backoff before each retried call", async () => {
		const events: string[] = [];
		let attempts = 0;
		const produce = vi.fn(async () => {
			events.push(`produce:${attempts}`);
			attempts++;
			if (attempts < 3) throw new Error("terminated");
			return "recovered";
		});
		await expect(
			retryTransientCall(produce, alwaysRetryable, enabled, undefined, {
				onRetryScheduled: (attempt) => {
					events.push(`retry:${attempt}`);
				},
				onRetryAttemptStart: () => {
					events.push("attempt-start");
				},
			}),
		).resolves.toBe("recovered");
		expect(events).toEqual([
			"produce:0",
			"retry:1",
			"attempt-start",
			"produce:1",
			"retry:2",
			"attempt-start",
			"produce:2",
		]);
	});

	it("aborts the backoff sleep via signal instead of running another attempt", async () => {
		const controller = new AbortController();
		const produce = vi.fn(async () => {
			throw new Error("terminated");
		});
		const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 10_000 };
		const onRetryFinished = vi.fn();
		const pending = retryTransientCall(produce, alwaysRetryable, policy, controller.signal, {
			onRetryFinished,
		}).catch((error: unknown) => error);
		await vi.waitFor(() => expect(produce).toHaveBeenCalled());
		controller.abort();
		await pending;
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1, "terminated");
	});
});
