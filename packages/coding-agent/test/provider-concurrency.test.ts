import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createProviderSemaphores } from "../src/core/provider-concurrency.ts";

/**
 * Slot hand-off is promise-based, so one macrotask boundary is a deterministic
 * quiescence point. Never replace this with a timed sleep.
 */
function flush(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

function assistantMessage(provider: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider,
		model: "test-model",
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

/** A provider stand-in whose streams settle by hand, never by a clock. */
class ControllableProvider {
	calls = 0;
	readonly streams: AssistantMessageEventStream[] = [];

	stream = (): AssistantMessageEventStream => {
		this.calls++;
		const stream = createAssistantMessageEventStream();
		this.streams.push(stream);
		return stream;
	};

	finish(index: number, provider = "alpha"): void {
		this.streams[index]?.push({ type: "done", reason: "stop", message: assistantMessage(provider) });
	}

	reject(index: number, error: unknown): void {
		this.streams[index]?.fail(error);
	}
}

describe("provider concurrency semaphores", () => {
	it("holds requests above the limit until an in-flight stream result settles", async () => {
		const provider = new ControllableProvider();
		const limiter = createProviderSemaphores(() => 2);

		const pending = [
			limiter.bracket("alpha", undefined, provider.stream),
			limiter.bracket("alpha", undefined, provider.stream),
			limiter.bracket("alpha", undefined, provider.stream),
		];
		await flush();

		expect(provider.calls).toBe(2);

		provider.finish(0);
		await flush();

		expect(provider.calls).toBe(3);
		provider.finish(1);
		provider.finish(2);
		await Promise.all(pending);
	});

	it("releases the slot when a stream result rejects", async () => {
		const provider = new ControllableProvider();
		const limiter = createProviderSemaphores(() => 1);

		const first = await limiter.bracket("alpha", undefined, provider.stream);
		const second = limiter.bracket("alpha", undefined, provider.stream);
		await flush();
		expect(provider.calls).toBe(1);

		provider.reject(0, new Error("upstream refused"));
		await flush();

		expect(provider.calls).toBe(2);
		await expect(first.result()).rejects.toThrow("upstream refused");
		provider.finish(1);
		await (await second).result();
	});

	it("rejects a waiting request with the abort reason and never calls the provider", async () => {
		const provider = new ControllableProvider();
		const limiter = createProviderSemaphores(() => 1);
		const controller = new AbortController();
		const reason = new Error("caller went away");

		const first = await limiter.bracket("alpha", undefined, provider.stream);
		const waiting = limiter.bracket("alpha", controller.signal, provider.stream);
		await flush();
		expect(provider.calls).toBe(1);

		controller.abort(reason);

		await expect(waiting).rejects.toBe(reason);
		expect(provider.calls).toBe(1);

		provider.finish(0);
		await first.result();
	});

	it("releases the slot when the provider call itself throws", async () => {
		const provider = new ControllableProvider();
		const limiter = createProviderSemaphores(() => 1);

		await expect(
			limiter.bracket("alpha", undefined, () => {
				throw new Error("provider refused to start");
			}),
		).rejects.toThrow("provider refused to start");

		const next = await limiter.bracket("alpha", undefined, provider.stream);
		await flush();

		expect(provider.calls).toBe(1);
		provider.finish(0);
		await next.result();
	});

	it("runs unlimited when the provider has no configured cap", async () => {
		const provider = new ControllableProvider();
		const limiter = createProviderSemaphores(() => Number.POSITIVE_INFINITY);

		const pending = [
			limiter.bracket("alpha", undefined, provider.stream),
			limiter.bracket("alpha", undefined, provider.stream),
			limiter.bracket("alpha", undefined, provider.stream),
		];
		await flush();

		expect(provider.calls).toBe(3);
		for (const [index] of pending.entries()) provider.finish(index);
		await Promise.all(pending);
	});

	it("keeps one semaphore per provider", async () => {
		const alpha = new ControllableProvider();
		const beta = new ControllableProvider();
		const limiter = createProviderSemaphores(() => 1);

		const pending = [
			limiter.bracket("alpha", undefined, alpha.stream),
			limiter.bracket("alpha", undefined, alpha.stream),
			limiter.bracket("beta", undefined, beta.stream),
		];
		await flush();

		expect(alpha.calls).toBe(1);
		expect(beta.calls).toBe(1);

		alpha.finish(0);
		beta.finish(0, "beta");
		await flush();

		expect(alpha.calls).toBe(2);
		alpha.finish(1);
		await Promise.all(pending);
	});

	it("releases waiters when the limit is resized upwards", async () => {
		const provider = new ControllableProvider();
		let limit = 1;
		const limiter = createProviderSemaphores(() => limit);

		const pending = [
			limiter.bracket("alpha", undefined, provider.stream),
			limiter.bracket("alpha", undefined, provider.stream),
			limiter.bracket("alpha", undefined, provider.stream),
		];
		await flush();
		expect(provider.calls).toBe(1);

		limit = 3;
		limiter.resize("alpha", limit);
		await flush();

		expect(provider.calls).toBe(3);
		for (const [index] of pending.entries()) provider.finish(index);
		await Promise.all(pending);
	});
});
