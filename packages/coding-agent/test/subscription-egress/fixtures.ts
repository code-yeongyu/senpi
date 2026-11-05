import { getModels } from "@earendil-works/pi-ai/compat";
import { vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { overrideAuthLaneBoundary } from "../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import {
	overrideSdkBoundary,
	type SDKMessage,
	type SdkQueryHandle,
	type SdkQueryInput,
} from "../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import type { ProviderCallOutput } from "../../src/subscription-egress/index.ts";

export const scope = { threadId: "thread-a", epoch: 1, cwd: process.cwd(), affinityId: "local-affinity" };
const model = getModels("anthropic")[0];
if (!model) throw new Error("Anthropic catalog is empty");
export const request = {
	type: "provider.call.start",
	version: 1,
	threadId: scope.threadId,
	epoch: scope.epoch,
	callId: "call-a",
	provider: "anthropic-subscription",
	model: model.id,
	context: { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] },
	options: {},
};
export const cancel = (callId = request.callId) => ({
	type: "provider.call.cancel",
	version: 1,
	threadId: scope.threadId,
	epoch: scope.epoch,
	callId,
});

export function prepare() {
	vi.stubEnv("SENPI_EXPERIMENTAL_SUBSCRIPTION_EGRESS", "1");
	vi.stubEnv("SENPI_CLAUDE_SDK_OAUTH_ENABLED", "true");
	vi.stubEnv("SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION", "ambient");
	overrideAuthLaneBoundary({ createStore: () => AuthStorage.inMemory(), env: () => ({}) });
}

export const sdk = (value: unknown) => value as SDKMessage;
export const success = sdk({
	type: "result",
	subtype: "success",
	result: "hello",
	stop_reason: "end_turn",
	usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
});

export function scripted(messages: SDKMessage[], inspect?: (input: SdkQueryInput) => void) {
	const query = vi.fn((input: SdkQueryInput): SdkQueryHandle => {
		inspect?.(input);
		return {
			async *[Symbol.asyncIterator]() {
				yield* messages;
			},
			interrupt: async () => {},
			close: () => {},
		};
	});
	overrideSdkBoundary({ query });
	return query;
}

export function stalled() {
	const opened = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const interrupted = vi.fn(async () => {});
	const closed = vi.fn(() => finished.resolve());
	const query = vi.fn((_input: SdkQueryInput): SdkQueryHandle => ({
		async *[Symbol.asyncIterator]() {
			opened.resolve();
			yield sdk({
				type: "stream_event",
				event: { type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0 } } },
			});
			await finished.promise;
			yield success;
		},
		interrupt: interrupted,
		close: closed,
	}));
	overrideSdkBoundary({ query });
	return { query, opened: opened.promise, interrupted, closed };
}

export function outputSink() {
	const messages: ProviderCallOutput[] = [];
	return {
		messages,
		send: async (message: ProviderCallOutput) => {
			messages.push(message);
		},
	};
}
