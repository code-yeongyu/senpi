/**
 * oh-my-openagent#7975: on the resident anthropic-subscription lane senpi stands
 * compaction down because the Claude Agent SDK compacts its own transcript. A
 * cold-seed (the resident session was lost) re-sends senpi's WHOLE history as one
 * user message instead; the SDK cannot compact a single exchange, the request is
 * rejected as "Prompt is too long", and senpi rejected its own overflow recovery
 * as `external-owner`, so the session died for good.
 *
 * Drives a real AgentSession through the real provider stream and the real
 * compaction extension against a scripted SDK.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	getCurrentTools,
	wrapStreamWithModelRecovery,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import type { SDKMessage } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { closeSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	sdkMessage,
	streamEvent,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { createHarness, type Harness } from "../harness.ts";

// Claude Code 2.1.280's own rejection text for an oversized single-exchange request.
const OVERFLOW_TEXT =
	"Prompt is too long · the request is ~1119185 tokens (limit 1000000) but this conversation is only ~659662 tokens — the rest is system prompt, tool definitions, and attachment content. A single-exchange conversation cannot be compacted; reduce attached files/tools or start with less context.";
// Persisted with the failed assistant message, so a restarted session reads the same value.
const COLD_SEED_OVERFLOW_MARKER = "claude_sdk_oauth_cold_seed_overflow";
const EARLIER_WORK = "earlier work ".repeat(400);

type Reply = (sessionId: string, userUuid: string) => SDKMessage[];

const answer =
	(text: string, inputTokens = 10): Reply =>
	(sessionId, userUuid) => [
		streamEvent(sessionId, { type: "message_start", message: { usage: { input_tokens: inputTokens } } }),
		streamEvent(sessionId, { type: "content_block_start", index: 0, content_block: { type: "text" } }),
		streamEvent(sessionId, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		streamEvent(sessionId, { type: "content_block_stop", index: 0 }),
		streamEvent(sessionId, {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 4 },
		}),
		sdkMessage({
			type: "result",
			subtype: "success",
			result: text,
			user_message_uuid: userUuid,
			session_id: sessionId,
			usage: { input_tokens: inputTokens, output_tokens: 4 },
		}),
	];

const overflow: Reply = (sessionId) => [
	sdkMessage({
		type: "assistant",
		message: { id: "rejected", type: "message", role: "assistant", content: [{ type: "text", text: OVERFLOW_TEXT }] },
		parent_tool_use_id: null,
		uuid: "assistant-rejected",
		session_id: sessionId,
		error: "invalid_request",
	}),
];

const residentStreamFn: StreamFn = (model, context, options) =>
	wrapStreamWithModelRecovery(
		streamAnthropicSubscription(model, context, options),
		model,
		getCurrentTools(context.messages),
	);

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	resetScriptedSdk();
});

async function laneSession(replies: Reply[], compactionOwner: "sdk" | "senpi" = "sdk") {
	// #7975 is a regression of the SDK-owned lane (now the `compactionOwner: "sdk"` opt-out); the
	// default senpi-owned lane is covered below.
	vi.stubEnv("SENPI_CLAUDE_SDK_OAUTH_COMPACTION_OWNER", compactionOwner);
	await installSingleAccountLane();
	let call = 0;
	installScriptedSdk((sessionId, userUuid) => {
		const reply = replies[call];
		call += 1;
		if (!reply) throw new Error(`unscripted SDK submission ${call}`);
		return reply(sessionId, userUuid);
	});
	const harness = await createHarness({
		api: CLAUDE_SDK_OAUTH_API_ID,
		provider: SCRIPTED_PROVIDER,
		models: [{ id: "claude-test", contextWindow: 200_000 }],
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [(pi) => registerSessionRegistry(pi), compactionExtension],
	});
	harnesses.push(harness);
	harness.agent.streamFunction = residentStreamFn;
	const sessionId = harness.sessionManager.getSessionId();
	harness.agent.sessionId = sessionId;
	// The faux model behind the same provider id answers senpi's own summarization.
	harness.setResponses([fauxAssistantMessage("summary of the earlier work")]);
	const loseResidentSession = () => {
		closeSession(sessionId, "test_lost_resident_session");
		forgetBinding(sessionId);
	};
	return { harness, calls: () => call, loseResidentSession };
}

function lastAssistant(harness: Harness): AssistantMessage | undefined {
	return [...harness.session.messages].reverse().find((message) => message.role === "assistant") as
		| AssistantMessage
		| undefined;
}

function compactionOutcomes(harness: Harness) {
	return harness.eventsOfType("compaction_end").map((event) => ({
		reason: event.reason,
		accepted: event.accepted !== false && event.result !== undefined,
		rejectionCause: event.rejectionCause,
	}));
}

describe("oh-my-openagent#7975 cold-seed overflow on the anthropic-subscription lane", () => {
	it("compacts senpi's history once and retries when a cold-seed re-send is rejected as too long", async () => {
		// First turn is large enough to pass the threshold, so the lane rejects a
		// threshold compaction as external-owner before the overflow ever happens.
		const lane = await laneSession([answer(EARLIER_WORK, 199_000), overflow, answer("continued after compaction")]);

		await lane.harness.session.prompt("first");
		lane.loseResidentSession();
		await lane.harness.session.prompt("second");

		const outcomes = compactionOutcomes(lane.harness);
		expect(outcomes).toContainEqual({ reason: "threshold", accepted: false, rejectionCause: "external-owner" });
		expect(outcomes).toContainEqual({ reason: "overflow", accepted: true, rejectionCause: undefined });
		expect(lane.calls()).toBe(3);
		expect(lastAssistant(lane.harness)).toMatchObject({ stopReason: "stop" });
		// Recovery drops the rejected turn from context; the ledger keeps it with its marker.
		const rejected = lane.harness.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
			.find((message) => message.role === "assistant" && message.stopReason === "error") as
			| AssistantMessage
			| undefined;
		expect(rejected?.diagnostics?.map((diagnostic) => diagnostic.type)).toContain(COLD_SEED_OVERFLOW_MARKER);
	}, 30_000);

	it("leaves a resident (delta) overflow to the SDK: no marker, no senpi compaction", async () => {
		const lane = await laneSession([answer("first answer"), overflow]);

		await lane.harness.session.prompt("first");
		await lane.harness.session.prompt("second");

		const rejected = lastAssistant(lane.harness);
		expect(rejected).toMatchObject({ stopReason: "error" });
		expect(rejected?.diagnostics?.map((diagnostic) => diagnostic.type) ?? []).not.toContain(
			COLD_SEED_OVERFLOW_MARKER,
		);
		expect(compactionOutcomes(lane.harness)).not.toContainEqual(
			expect.objectContaining({ reason: "overflow", accepted: true }),
		);
		expect(lane.calls()).toBe(2);
	}, 30_000);

	it("recovers a restarted session whose last turn is a marked cold-seed overflow", async () => {
		const lane = await laneSession([answer("resumed after compaction")]);
		const model = lane.harness.getModel();
		const persisted: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_TEXT }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			diagnostics: [{ type: COLD_SEED_OVERFLOW_MARKER, timestamp: Date.now() }],
		};
		lane.harness.sessionManager.appendMessage({ role: "user", content: EARLIER_WORK, timestamp: Date.now() });
		lane.harness.sessionManager.appendMessage(persisted);
		lane.harness.session.agent.state.messages = lane.harness.sessionManager.buildSessionContext().messages;

		await lane.harness.session.prompt("resume");

		expect(compactionOutcomes(lane.harness)).toContainEqual({
			reason: "overflow",
			accepted: true,
			rejectionCause: undefined,
		});
		expect(lastAssistant(lane.harness)).toMatchObject({ stopReason: "stop" });
	}, 30_000);
});

// Default contract (`compactionOwner: "senpi"`): senpi owns the resident lane's compaction, so a turn
// over the threshold is compacted by senpi and the next turn cold-seeds a fresh SDK session
// from the compacted branch instead of growing the old SDK transcript.
describe("anthropic-subscription lane: senpi-owned compaction (compactionOwner: senpi)", () => {
	it("compacts at the threshold and cold-seeds the next turn into a fresh SDK session", async () => {
		const sdkSessions: string[] = [];
		const record =
			(reply: Reply): Reply =>
			(sessionId, userUuid) => {
				sdkSessions.push(sessionId);
				return reply(sessionId, userUuid);
			};
		const lane = await laneSession(
			[record(answer(EARLIER_WORK, 199_000)), record(answer("continued after compaction"))],
			"senpi",
		);

		await lane.harness.session.prompt("first");
		await lane.harness.session.prompt("second");

		const outcomes = compactionOutcomes(lane.harness);
		expect(outcomes.some((outcome) => outcome.accepted)).toBe(true);
		expect(outcomes).not.toContainEqual(expect.objectContaining({ rejectionCause: "external-owner" }));
		expect(lane.harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(lane.calls()).toBe(2);
		expect(sdkSessions[1]).not.toBe(sdkSessions[0]);
		expect(lastAssistant(lane.harness)).toMatchObject({ stopReason: "stop" });
	}, 30_000);
});
