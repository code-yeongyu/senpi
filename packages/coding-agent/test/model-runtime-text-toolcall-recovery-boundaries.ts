import {
	type AssistantMessageEvent,
	AssistantMessageEventStream,
	type AssistantMessageEventStream as AssistantStream,
	type Context,
	type Model,
	type Provider,
	Type,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const tools: Context["tools"] = [
	{ name: "Echo", description: "Echo text", parameters: Type.Object({ value: Type.String() }) },
];

function model(id: string): Model {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "runtime-recovery",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function errorStream(selected: Model, reason: "error" | "aborted"): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const error = {
			role: "assistant" as const,
			api: selected.api,
			provider: selected.provider,
			model: selected.id,
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: reason,
			errorMessage: reason,
			timestamp: 1,
		};
		stream.push({ type: "error", reason, error });
	});
	return stream;
}

async function runtimeWithStreams(
	streamFactory: (selected: Model) => AssistantStream,
): Promise<{ runtime: ModelRuntime; selected: Model; calls: { stream: number; simple: number } }> {
	const selectedModel = model("claude-boundary");
	const calls = { stream: 0, simple: 0 };
	const provider: Provider = {
		id: selectedModel.provider,
		name: "Boundary provider",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
		getModels: () => [selectedModel],
		stream: (selected) => {
			calls.stream++;
			return streamFactory(selected);
		},
		streamSimple: (selected) => {
			calls.simple++;
			return streamFactory(selected);
		},
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(provider);
	return { runtime, selected: runtime.getModel(provider.id, selectedModel.id)!, calls };
}

function cancellableStream(onReturn: () => Promise<void>): AssistantStream {
	let deliveredStart = false;
	return {
		[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
			return {
				next: async () => {
					if (deliveredStart) return new Promise<IteratorResult<AssistantMessageEvent>>(() => {});
					deliveredStart = true;
					return {
						done: false,
						value: {
							type: "start",
							partial: errorStream(model("unused"), "error").queue[0]?.error ?? {
								role: "assistant",
								api: "anthropic-messages",
								provider: "runtime-recovery",
								model: "claude-boundary",
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
							},
						},
					};
				},
				return: async () => {
					await onReturn();
					return { done: true, value: undefined };
				},
			};
		},
	} as AssistantStream;
}

export function registerModelRuntimeRecoveryBoundaryCases(): void {
	it("propagates provider throws errors aborts and cancellation through both runtime entry points", async () => {
		for (const kind of ["stream", "simple"] as const) {
			const thrown = await runtimeWithStreams(() => {
				throw new Error("provider threw");
			});
			const thrownResult = await (kind === "stream"
				? thrown.runtime.stream(thrown.selected, { messages: [], tools }).result()
				: thrown.runtime.streamSimple(thrown.selected, { messages: [], tools }).result());
			expect(thrownResult).toMatchObject({ stopReason: "error", errorMessage: "provider threw" });
			expect(thrown.calls[kind]).toBe(1);

			for (const reason of ["error", "aborted"] as const) {
				const terminal = await runtimeWithStreams((selected) => errorStream(selected, reason));
				const result = await (kind === "stream"
					? terminal.runtime.stream(terminal.selected, { messages: [], tools }).result()
					: terminal.runtime.streamSimple(terminal.selected, { messages: [], tools }).result());
				expect(result.stopReason).toBe(reason);
				expect(terminal.calls[kind]).toBe(1);
			}

			let releaseReturn!: () => void;
			const returnStarted = new Promise<void>((resolve) => (releaseReturn = resolve));
			let returnInvoked!: () => void;
			const invoked = new Promise<void>((resolve) => (returnInvoked = resolve));
			let returned = 0;
			const cancelled = await runtimeWithStreams(() =>
				cancellableStream(async () => {
					returned++;
					returnInvoked();
					await returnStarted;
				}),
			);
			const runtimeStream =
				kind === "stream"
					? cancelled.runtime.stream(cancelled.selected, { messages: [], tools })
					: cancelled.runtime.streamSimple(cancelled.selected, { messages: [], tools });
			const iterator = runtimeStream[Symbol.asyncIterator]();
			await iterator.next();
			const cancellation = iterator.return?.();
			await invoked;
			expect(returned).toBe(1);
			releaseReturn();
			await cancellation;
			expect(cancelled.calls[kind]).toBe(1);
			expect(returned).toBe(1);
		}
	});

	it("creates independent recovery wrappers for concurrent runtime calls", async () => {
		const concurrent = await runtimeWithStreams((selected) => {
			const stream = new AssistantMessageEventStream();
			const text = '<invoke name="Echo"><parameter name="value">hello</parameter></invoke>';
			const partial = errorStream(selected, "error").queue[0]?.error ?? {
				role: "assistant" as const,
				api: selected.api,
				provider: selected.provider,
				model: selected.id,
				content: [{ type: "text" as const, text }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: 1,
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...partial, content: [] } });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			});
			return stream;
		});
		const context = { messages: [], tools } satisfies Context;
		const [first, second] = await Promise.all([
			concurrent.runtime.streamSimple(concurrent.selected, context).result(),
			concurrent.runtime.streamSimple(concurrent.selected, context).result(),
		]);
		for (const result of [first, second]) {
			expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "recovered-antml-0" }));
		}
		expect(concurrent.calls.simple).toBe(2);
	});
}
