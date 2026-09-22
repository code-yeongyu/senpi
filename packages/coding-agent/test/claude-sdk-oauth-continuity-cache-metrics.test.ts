import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	type ContinuityObservation,
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { streamClaudeSdkOauth } from "../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";
import { CONTINUITY_DIAGNOSTIC_TYPE } from "../src/modes/interactive/components/continuity-notice.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

/**
 * Resident query whose successful result carries the usage fixture (or none):
 * usage and num_turns ride the SDK result message, which is where the retained
 * attempt reads them from.
 */
function usageResidentQuery(resultUsage: Record<string, number> | undefined): SdkQuery {
	return (input) => {
		const { prompt } = input;
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const generator = (async function* (): AsyncGenerator<SDKMessage> {
			let submitted = 0;
			for await (const message of prompt) {
				submitted++;
				const uuid = message.uuid ?? `submitted-${submitted}`;
				yield sdkMessage({ ...message, uuid, isReplay: true });
				yield sdkMessage({
					type: "assistant",
					message: { id: `message-${uuid}`, type: "message", role: "assistant", content: [] },
					parent_tool_use_id: null,
					uuid: `assistant-${uuid}`,
					session_id: message.session_id,
				});
				yield sdkMessage({
					type: "result",
					subtype: "success",
					result: "ok",
					user_message_uuid: uuid,
					uuid: `result-${uuid}`,
					session_id: message.session_id,
					...(resultUsage === undefined ? {} : { usage: resultUsage, num_turns: 1 }),
				});
			}
		})();
		return {
			[Symbol.asyncIterator]: () => generator,
			initializationResult: async () => ({}),
			interrupt: async () => {},
			close: () => {
				void generator.return(undefined);
			},
		};
	};
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

const sessionIds = new Set<string>();

function mainOptions(sessionId: string) {
	sessionIds.add(sessionId);
	return { sessionId, streamKind: "main" as const };
}

function observationSink() {
	const observations: ContinuityObservation[] = [];
	const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
	overrideContinuityObservabilityBoundary({
		emit: (observation) => observations.push(observation),
		log: (event, data) => logged.push({ event, data }),
	});
	return { observations, logged };
}

function continuityDiagnostic(
	message: AssistantMessage,
): NonNullable<AssistantMessage["diagnostics"]>[number] | undefined {
	return message.diagnostics?.find((candidate) => candidate.type === CONTINUITY_DIAGNOSTIC_TYPE);
}

afterEach(() => {
	for (const sessionId of sessionIds) closeSession(sessionId, "test_cleanup");
	sessionIds.clear();
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetContinuityObservabilityBoundary();
});

describe("retained attempt cache metrics", () => {
	it("carries the retained attempt's result usage and num_turns on the observation, log line, and diagnostic details", async () => {
		const query = usageResidentQuery({
			input_tokens: 12,
			cache_read_input_tokens: 25_458,
			cache_creation_input_tokens: 41_516,
		});
		overrideSdkBoundary({ query });
		overrideSessionRegistryBoundary({ queryFactory: query });
		const sink = observationSink();
		const sessionId = "cache-metrics-usage";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		const first = await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();

		expect(sink.observations.at(-1)).toMatchObject({
			kind: "bootstrap",
			reason: "registry_miss",
			cacheRead: 25_458,
			cacheWrite: 41_516,
			inputTokens: 12,
			numTurns: 1,
		});
		expect(sink.logged.at(-1)?.data).toMatchObject({
			cacheRead: 25_458,
			cacheWrite: 41_516,
			inputTokens: 12,
			numTurns: 1,
		});
		expect(continuityDiagnostic(first)?.details).toMatchObject({
			cacheRead: 25_458,
			cacheWrite: 41_516,
			inputTokens: 12,
			numTurns: 1,
		});

		const second = await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), { role: "user", content: "two", timestamp: 3 }] },
			mainOptions(sessionId),
		).result();

		expect(continuityDiagnostic(second)?.details).toMatchObject({ kind: "delta", cacheRead: 25_458 });
		expect(sink.observations.at(-1)).toMatchObject({ kind: "delta", reason: "prefix_matched", cacheRead: 25_458 });
	});

	it("leaves the cache fields absent when the result reported no usage", async () => {
		const query = usageResidentQuery(undefined);
		overrideSdkBoundary({ query });
		overrideSessionRegistryBoundary({ queryFactory: query });
		const sink = observationSink();
		const sessionId = "cache-metrics-no-usage";
		await streamClaudeSdkOauth(
			model,
			{ messages: [{ role: "user", content: "one", timestamp: 1 }] },
			mainOptions(sessionId),
		).result();

		const observation = sink.observations.at(-1);
		expect(observation).toMatchObject({ kind: "bootstrap", reason: "registry_miss" });
		expect(observation).not.toHaveProperty("cacheRead");
		expect(observation).not.toHaveProperty("cacheWrite");
		expect(observation).not.toHaveProperty("inputTokens");
		expect(observation).not.toHaveProperty("numTurns");
	});
});
