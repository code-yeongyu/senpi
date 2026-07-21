import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

function createSetupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

class LazyAssistantMessageEventStream extends AssistantMessageEventStream {
	private cancellationHandler: (() => Promise<void>) | undefined;

	setCancellationHandler(handler: () => Promise<void>): void {
		this.cancellationHandler = handler;
	}

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const iterator = super[Symbol.asyncIterator]();
		return {
			next: () => iterator.next(),
			return: async () => {
				await this.cancellationHandler?.();
				return { value: undefined, done: true };
			},
		};
	}
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
	iterator: AsyncIterator<AssistantMessageEvent>,
): Promise<void> {
	for (;;) {
		const event = await iterator.next();
		if (event.done) break;
		target.push(event.value);
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	const outer = new LazyAssistantMessageEventStream();
	const inner = setup();
	const iterator = inner.then((source) => source[Symbol.asyncIterator]());
	let cancellation: Promise<void> | undefined;
	outer.setCancellationHandler(() => {
		cancellation ??= iterator.then(async (sourceIterator) => {
			await sourceIterator.return?.();
		});
		return cancellation;
	});

	Promise.all([inner, iterator])
		.then(([source, sourceIterator]) => forwardStream(outer, source, sourceIterator))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
	return {
		stream: (model, context, options) =>
			lazyStream(model, async () => (await load()).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
	};
}
