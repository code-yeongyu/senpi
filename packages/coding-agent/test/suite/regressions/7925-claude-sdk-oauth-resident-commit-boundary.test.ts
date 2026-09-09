/**
 * oh-my-openagent#7925: after a cold-seed turn on the resident claude-sdk-oauth
 * lane, the NEXT turn flattened again with `assistant_rewritten` even though no
 * extension touched the assistant. The commit boundary compared a hash taken at
 * the last `message_update` against the `message_end` message, and every field
 * the stream pipeline stamps after that update (senpi#691 denylisted one) made
 * the two differ. The fingerprint now covers only the answer itself.
 *
 * The first case drives a real AgentSession (harness) through the real provider
 * stream (`streamClaudeSdkOauth` + `wrapStreamWithModelRecovery`, exactly as
 * model-runtime composes it) against a scripted SDK that emits a realistic
 * thinking + signature + text turn, then asserts turn 2 is an incremental delta.
 */

import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { wrapStreamWithModelRecovery } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantCommitBoundary } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-commit-boundary.ts";
import type { ContinuityObservation } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import { closeSession, getSession } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import { streamClaudeSdkOauth } from "../../../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	sdkMessage,
	streamEvent,
} from "../../helpers/claude-sdk-oauth-scripted-sdk.ts";
import { createHarness, type Harness } from "../harness.ts";

const MODEL_ID = "claude-test";

function thinkingThenText(sessionId: string, userUuid: string, turn: number) {
	const answer = `answer ${turn}`;
	const event = (value: unknown) => streamEvent(sessionId, value);
	return [
		event({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
		event({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
		event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } }),
		event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } }),
		event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${turn}` } }),
		event({ type: "content_block_stop", index: 0 }),
		event({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
		event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: answer.slice(0, 3) } }),
		event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: answer.slice(3) } }),
		event({ type: "content_block_stop", index: 1 }),
		event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
		sdkMessage({
			type: "assistant",
			message: { id: `assistant-${userUuid}`, type: "message", role: "assistant", content: [] },
			parent_tool_use_id: null,
			uuid: `assistant-turn-${turn}`,
			session_id: sessionId,
		}),
		sdkMessage({
			type: "result",
			subtype: "success",
			result: answer,
			user_message_uuid: userUuid,
			session_id: sessionId,
			usage: { input_tokens: 10, output_tokens: 4 },
		}),
	];
}

const echoTool = {
	name: "echo",
	label: "echo",
	description: "echo",
	parameters: { type: "object", properties: { text: { type: "string" } } },
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
} as unknown as AgentTool;

/** The exact composition model-runtime applies to every provider stream. */
const residentStreamFn: StreamFn = (model, context, options) =>
	wrapStreamWithModelRecovery(streamClaudeSdkOauth(model, context, options), model, context.tools ?? []);

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	resetScriptedSdk();
	resetContinuityObservabilityBoundary();
});

describe("oh-my-openagent#7925 resident commit boundary", () => {
	it("keeps a plain thinking+text turn clean so the next turn is an incremental delta", async () => {
		await installSingleAccountLane();
		const observations: ContinuityObservation[] = [];
		overrideContinuityObservabilityBoundary({ emit: (observation) => observations.push(observation) });
		installScriptedSdk(thinkingThenText);

		const harness = await createHarness({
			api: SCRIPTED_PROVIDER,
			provider: SCRIPTED_PROVIDER,
			models: [{ id: MODEL_ID }],
			tools: [echoTool],
			extensionFactories: [(pi) => registerSessionRegistry(pi)],
		});
		harnesses.push(harness);
		harness.agent.streamFunction = residentStreamFn;
		const sessionId = harness.sessionManager.getSessionId();
		harness.agent.sessionId = sessionId;

		try {
			await harness.session.prompt("first");
			const afterTurnOne = getSession(sessionId);
			expect(afterTurnOne?.pendingForkReason ?? null).toBeNull();
			expect(afterTurnOne?.taintedReason ?? null).toBeNull();

			await harness.session.prompt("second");
			expect(observations.map((observation) => `${observation.kind}/${observation.reason}`)).toEqual([
				"bootstrap/registry_miss",
				"delta/prefix_matched",
			]);
		} finally {
			closeSession(sessionId, "test_cleanup");
			forgetBinding(sessionId);
		}
	}, 20_000);

	it("ignores transport metadata stamped after the last message_update but still catches rewrites", () => {
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const streamed = {
			role: "assistant" as const,
			api: SCRIPTED_PROVIDER,
			provider: SCRIPTED_PROVIDER,
			model: MODEL_ID,
			content: [
				{ type: "thinking" as const, thinking: "why", thinkingSignature: "sig", index: 0 },
				{ type: "text" as const, text: "answer", index: 1 },
				{
					type: "toolCall" as const,
					id: "toolu_1",
					name: "echo",
					arguments: { text: "hi" },
					partialJson: "{}",
					index: 2,
				},
			],
			stopReason: "toolUse" as const,
			timestamp: 1,
			usage,
		};
		const thinking = {
			type: "thinking" as const,
			thinking: "why",
			thinkingSignature: "sig",
			startedAt: 5,
			endedAt: 9,
		};
		const text = { type: "text" as const, text: "answer", textSignature: "later" };
		const toolCall = { type: "toolCall" as const, id: "toolu_1", name: "echo", arguments: { text: "hi" } };
		const committed = { ...streamed, content: [thinking, text, toolCall] };
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("metadata", streamed);
		expect(boundary.commit("metadata", committed, MODEL_ID)).toBe("clean");

		const rewrites = {
			text: [thinking, { ...text, text: "other" }, toolCall],
			thinking: [{ ...thinking, thinking: "else" }, text, toolCall],
			arguments: [thinking, text, { ...toolCall, arguments: { text: "bye" } }],
		};
		for (const [label, content] of Object.entries(rewrites)) {
			boundary.captureProviderFinal(label, streamed);
			expect(boundary.commit(label, { ...committed, content }, MODEL_ID), label).toBe("rewritten");
		}
	});
});
