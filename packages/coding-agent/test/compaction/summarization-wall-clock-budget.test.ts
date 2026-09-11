import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeSummarization } from "../../src/core/compaction/compaction.ts";
import {
	consumeStreamWithIdleTimeout,
	DEFAULT_SUMMARIZATION_MAX_DURATION_MS,
	StreamDurationBudgetError,
} from "../../src/core/compaction/stream-watchdog.ts";
import { OPENAI_NATIVE_LEGACY_MODEL } from "./openai-remote-test-models.ts";

/**
 * The idle watchdog only catches a *silent* provider connection. A summarization
 * stream that keeps trickling events stays under the idle budget forever, and
 * that work is serialized on the session's agent-event queue: a slow-but-alive
 * summarization freezes the whole session (tool results withheld at the batch
 * barrier, typed input queued, UI stuck on "Working") until the user presses ESC.
 * A wall-clock budget bounds that class the idle timer cannot see.
 *
 * Time is driven by fake timers: this is timer behavior, and real delays would
 * only flake under CI load.
 */

type Tick = { type: string };

/** A stream that keeps emitting just under the idle budget, forever. */
function trickleStream(intervalMs: number): AsyncIterable<Tick> {
	return {
		async *[Symbol.asyncIterator]() {
			while (true) {
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
				yield { type: "tick" };
			}
		},
	};
}

describe("consumeStreamWithIdleTimeout wall-clock budget", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts a trickling stream that outlives the total duration budget", async () => {
		let aborted = false;
		const seen: string[] = [];
		const outcome = consumeStreamWithIdleTimeout(trickleStream(90), {
			idleTimeoutMs: 1000,
			maxDurationMs: 500,
			abort: () => {
				aborted = true;
			},
			onEvent: (event) => seen.push(event.type),
		}).catch((caught: unknown) => caught);

		await vi.advanceTimersByTimeAsync(600);

		const error = await outcome;
		expect(error).toBeInstanceOf(StreamDurationBudgetError);
		expect((error as StreamDurationBudgetError).message).toContain("500ms");
		expect(aborted).toBe(true);
		// The stream was healthy right up to the budget: events kept arriving.
		expect(seen.length).toBeGreaterThan(0);
	});

	it("leaves a stream that finishes inside the budget untouched", async () => {
		let aborted = false;
		const events: Tick[] = [{ type: "a" }, { type: "b" }];
		const stream = {
			async *[Symbol.asyncIterator]() {
				for (const event of events) {
					await new Promise((resolve) => setTimeout(resolve, 10));
					yield event;
				}
			},
		};
		const seen: string[] = [];
		const done = consumeStreamWithIdleTimeout(stream, {
			idleTimeoutMs: 1000,
			maxDurationMs: 5000,
			abort: () => {
				aborted = true;
			},
			onEvent: (event) => seen.push(event.type),
		});
		await vi.advanceTimersByTimeAsync(100);
		await done;
		expect(seen).toEqual(["a", "b"]);
		expect(aborted).toBe(false);
	});

	it("caller abort still wins over the duration budget", async () => {
		const controller = new AbortController();
		const outcome = consumeStreamWithIdleTimeout(trickleStream(10), {
			idleTimeoutMs: 60_000,
			maxDurationMs: 60_000,
			abort: () => {
				throw new Error("watchdog fired on caller abort");
			},
			signal: controller.signal,
		});
		controller.abort();
		await outcome;
	});

	it("starts the duration budget before the provider returns a stream", async () => {
		let requestSignal: AbortSignal | undefined;
		const outcome = completeSummarization(
			OPENAI_NATIVE_LEGACY_MODEL,
			{ systemPrompt: "", messages: [] },
			{ maxTokens: 32 },
			async (_model, _context, options) => {
				requestSignal = options?.signal;
				return await new Promise<never>(() => undefined);
			},
		).catch((caught: unknown) => caught);

		await vi.advanceTimersByTimeAsync(DEFAULT_SUMMARIZATION_MAX_DURATION_MS + 1);

		const pending = Symbol("pending");
		const observed = await Promise.race([outcome, Promise.resolve(pending)]);
		expect(observed).toBeInstanceOf(StreamDurationBudgetError);
		expect(requestSignal?.aborted).toBe(true);
	});

	it("exposes a default wall-clock budget below the idle timeout", () => {
		expect(DEFAULT_SUMMARIZATION_MAX_DURATION_MS).toBe(900_000);
	});
});
