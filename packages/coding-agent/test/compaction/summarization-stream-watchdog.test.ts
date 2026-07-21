import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	consumeStreamWithIdleTimeout,
	DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS,
	StreamIdleTimeoutError,
} from "../../src/core/compaction/stream-watchdog.ts";

/**
 * Compaction summarization streams must not wait forever on a dead provider
 * connection. A stalled stream (connected but silent) previously hung the
 * session until the user pressed ESC; now an idle watchdog tears the request
 * down and surfaces a typed error through the normal compaction failure path.
 *
 * Time is driven by fake timers: the watchdog is timer behavior, and real
 * delays would only flake under CI load.
 */

async function* stalledStream(): AsyncIterable<{ type: string }> {
	// Simulates a hung gateway: connection open, no bytes ever.
	await new Promise(() => {});
	yield { type: "never" };
}

type Tick = { type: string };

/** A pull-driven stream: each `advance()` releases exactly one scripted event. */
/** A pull-driven stream: each `advance()` releases exactly one scripted event. */
function scriptedStream(events: Tick[]): { stream: AsyncIterable<Tick>; advance: () => Promise<void> } {
	let index = 0;
	let waiter: (() => void) | undefined;
	const stream = {
		async *[Symbol.asyncIterator]() {
			while (index < events.length) {
				const { promise, resolve } = Promise.withResolvers<void>();
				waiter = resolve;
				await promise;
				const current = events[index] as Tick;
				index += 1;
				yield current;
			}
		},
	};
	const advance = async () => {
		waiter?.();
		// Flush microtasks so the generator produces and the consumer observes it.
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
	return { stream, advance };
}

describe("consumeStreamWithIdleTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("rejects with StreamIdleTimeoutError and aborts when the stream goes silent", async () => {
		let aborted = false;
		const outcome = consumeStreamWithIdleTimeout(stalledStream(), {
			idleTimeoutMs: 50,
			abort: () => {
				aborted = true;
			},
		}).catch((caught: unknown) => caught);
		await vi.advanceTimersByTimeAsync(50);
		const error = await outcome;
		expect(error).toBeInstanceOf(StreamIdleTimeoutError);
		expect((error as StreamIdleTimeoutError).message).toContain("50ms");
		expect(aborted).toBe(true);
	});

	it("passes every event through for a healthy stream", async () => {
		const { stream, advance } = scriptedStream([{ type: "a" }, { type: "b" }, { type: "c" }]);
		const seen: string[] = [];
		const done = consumeStreamWithIdleTimeout(stream, {
			idleTimeoutMs: 1000,
			abort: () => {},
			onEvent: (event) => seen.push(event.type),
		});
		await advance();
		await advance();
		await advance();
		await done;
		expect(seen).toEqual(["a", "b", "c"]);
	});

	it("resets the idle timer on every event", async () => {
		const { stream, advance } = scriptedStream([{ type: "a" }, { type: "b" }, { type: "c" }]);
		const seen: string[] = [];
		let aborted = false;
		const done = consumeStreamWithIdleTimeout(stream, {
			idleTimeoutMs: 100,
			abort: () => {
				aborted = true;
			},
			onEvent: (event) => seen.push(event.type),
		});
		for (let i = 0; i < 3; i++) {
			// Each event arrives just under the idle budget; the watchdog must never trip.
			await vi.advanceTimersByTimeAsync(90);
			await advance();
		}
		await done;
		expect(seen).toEqual(["a", "b", "c"]);
		expect(aborted).toBe(false);
	});

	it("ends the wait quietly on caller abort instead of masking it as an idle timeout", async () => {
		const controller = new AbortController();
		const outcome = consumeStreamWithIdleTimeout(stalledStream(), {
			idleTimeoutMs: 60_000,
			abort: () => {
				throw new Error("watchdog fired on caller abort");
			},
			signal: controller.signal,
		});
		controller.abort();
		// Resolves quietly: the stream's own aborted result is surfaced by the
		// caller through stream.result(), exactly as an ESC abort reads today.
		await outcome;
	});

	it("exposes a 5 minute default aligned with the agent stream idle timeout", () => {
		expect(DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS).toBe(300_000);
	});
});
