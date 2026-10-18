/**
 * senpi#2480: on the resident anthropic-subscription lane a long run can lose its
 * SDK session mid-turn and fail to resume it. The lane then cold-seeds senpi's
 * WHOLE history, which senpi never compacted on this lane, as one user message.
 * The bytes/4 pre-dispatch gate is a lower bound, so dense content passes it and
 * the API rejects the request as "Prompt is too long". Recovery had exactly one
 * compact-and-retry: when the retry was still too long the turn died, the goal was
 * blocked, and every later prompt was refused before any compaction ran
 * (oh-my-openagent#8411), so "Send any message to resume" was false.
 *
 * Drives a real AgentSession through the real provider stream and the real
 * compaction extension against a fake SDK that (1) rejects the resume, (2) counts
 * the payload denser than bytes/4 on top of a fixed prefix, and (3) answers once
 * the request fits.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	getCurrentTools,
	wrapStreamWithModelRecovery,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import type {
	SDKMessage,
	SDKUserMessage,
	SdkQuery,
	SdkQueryHandle,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import {
	installSingleAccountLane,
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	ScriptedResidentQuery,
	sdkMessage,
	streamEvent,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { createHarness, type Harness } from "../harness.ts";

const CONTEXT_WINDOW = 200_000;
// Persisted with the failed assistant message by the lane.
const COLD_SEED_OVERFLOW_MARKER = "claude_sdk_oauth_cold_seed_overflow";
const RESUME_FALLBACK_MARKER = "claude_sdk_oauth_resume_fallback";
// Four turns of 100 KB each: bytes/4 says ~100k tokens for the whole history (passes the
// 200k gate); the fake API below counts 1 token per byte and rejects it.
const WORK_CHUNK = "earlier work on the long task ".repeat(3_334);

/** What the fake API counts: a fixed prefix (system prompt, tools, SDK preamble) plus the payload. */
type FakeApi = { fixedTokens: number; tokensPerByte: number };

function payloadBytes(content: SDKUserMessage["message"]["content"]): number {
	if (typeof content === "string") return Buffer.byteLength(content, "utf8");
	let total = 0;
	for (const block of content) {
		if (block.type === "text") total += Buffer.byteLength(block.text, "utf8");
	}
	return total;
}

function answer(sessionId: string, userUuid: string, text: string): SDKMessage[] {
	return [
		streamEvent(sessionId, { type: "message_start", message: { usage: { input_tokens: 10 } } }),
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
			usage: { input_tokens: 10, output_tokens: 4 },
		}),
	];
}

// The bare rejection the TUI showed (the lane appends the error code); no token count to calibrate from.
const BARE_OVERFLOW = "Prompt is too long";
const BARE_OVERFLOW_AS_SEEN = "Prompt is too long (invalid_request)";

function rejectTooLong(sessionId: string, text: string): SDKMessage[] {
	return [
		sdkMessage({
			type: "assistant",
			message: { id: "rejected", type: "message", role: "assistant", content: [{ type: "text", text }] },
			parent_tool_use_id: null,
			uuid: "assistant-rejected",
			session_id: sessionId,
			error: "invalid_request",
		}),
	];
}

type FakeLane = {
	harness: Harness;
	api: FakeApi;
	/** Token counts the fake API saw, one per dispatched request. */
	requests: number[];
	/** Make the next resume attempt fail the way a lost SDK transcript does. */
	breakResume(): void;
	wording: (count: number) => string;
};

// Registered the moment a harness exists, so a failure later in setup still cleans it up.
const harnesses: Harness[] = [];

async function fakeLane(options: { keepRecentTokens: number; wording?: (count: number) => string }): Promise<FakeLane> {
	await installSingleAccountLane();
	const api: FakeApi = { fixedTokens: 60_000, tokensPerByte: 1 };
	const requests: number[] = [];
	let resumeBroken = false;
	let answers = 0;
	const wording = options.wording ?? (() => BARE_OVERFLOW);
	const query: SdkQuery = ({ prompt, options: queryOptions }) => {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		let handle: ScriptedResidentQuery | undefined;
		const scripted = new ScriptedResidentQuery(prompt, (sessionId, userUuid) => {
			const submitted = handle?.submitted.at(-1);
			if (!submitted) throw new Error("fake API saw no submission");
			const count = api.fixedTokens + Math.ceil(payloadBytes(submitted.message.content) * api.tokensPerByte);
			requests.push(count);
			if (count > CONTEXT_WINDOW) return rejectTooLong(sessionId, wording(count));
			answers += 1;
			return answer(sessionId, userUuid, `answer ${answers}`);
		});
		handle = scripted;
		const sdkHandle: SdkQueryHandle = scripted;
		const resumeTarget = queryOptions?.resume;
		if (resumeTarget !== undefined && resumeBroken) {
			resumeBroken = false;
			sdkHandle.initializationResult = () =>
				Promise.reject(new Error(`No conversation found with session ID: ${resumeTarget}`));
		}
		return sdkHandle;
	};
	overrideSdkBoundary({ query, createSdkMcpServer: (() => ({ type: "sdk", name: "senpi" })) as never });
	overrideSessionRegistryBoundary({ queryFactory: query });

	const harness = await createHarness({
		api: CLAUDE_SDK_OAUTH_API_ID,
		provider: SCRIPTED_PROVIDER,
		models: [{ id: "claude-test", contextWindow: CONTEXT_WINDOW }],
		settings: { compaction: { keepRecentTokens: options.keepRecentTokens } },
		extensionFactories: [(pi) => registerSessionRegistry(pi), compactionExtension],
	});
	harnesses.push(harness);
	harness.agent.streamFunction = ((model, context, streamOptions) =>
		wrapStreamWithModelRecovery(
			streamAnthropicSubscription(model, context, streamOptions),
			model,
			getCurrentTools(context.messages),
		)) satisfies StreamFn;
	const sessionId = harness.sessionManager.getSessionId();
	harness.agent.sessionId = sessionId;
	// The faux model behind the same provider id answers senpi's own summarization calls.
	harness.setResponses([
		fauxAssistantMessage("summary of the earlier work"),
		fauxAssistantMessage("summary of the earlier work"),
		fauxAssistantMessage("summary of the earlier work"),
	]);
	return {
		harness,
		api,
		requests,
		wording,
		breakResume: () => {
			// The resident process is gone (it died mid-turn); the binding still points at its session.
			closeSession(sessionId, "test_process_died");
			resumeBroken = true;
		},
	};
}

function assistants(harness: Harness): AssistantMessage[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
}

function diagnosticsOf(message: AssistantMessage | undefined): string[] {
	return (message?.diagnostics ?? []).map((diagnostic) => diagnostic.type);
}

function overflowCompactions(harness: Harness) {
	return harness
		.eventsOfType("compaction_end")
		.filter((event) => event.reason === "overflow")
		.map((event) => ({
			accepted: event.accepted !== false && event.result !== undefined,
			errorMessage: event.errorMessage,
		}));
}

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetScriptedSdk();
});

async function buildLongHistory(lane: FakeLane): Promise<void> {
	for (let turn = 1; turn <= 4; turn += 1) {
		await lane.harness.session.prompt(`${WORK_CHUNK} (turn ${turn})`);
	}
	expect(lane.requests).toHaveLength(4);
	expect(lane.requests.every((count) => count <= CONTEXT_WINDOW)).toBe(true);
}

describe("senpi#2480 cold-seed overflow after a failed resume on the anthropic-subscription lane", () => {
	it("climbs the recovery ladder inside the turn when the first compacted re-send is still too long", async () => {
		// keepRecentTokens 40k by senpi's estimate keeps ~200 KB of tail: still over the fake API's count.
		const lane = await fakeLane({ keepRecentTokens: 40_000 });
		await buildLongHistory(lane);

		lane.breakResume();
		await lane.harness.session.prompt("second");

		const persisted = assistants(lane.harness);
		// The resume failed and the lane fell back to re-sending everything.
		const resumeFallback = persisted.find((message) => diagnosticsOf(message).includes(RESUME_FALLBACK_MARKER));
		expect(resumeFallback).toMatchObject({ stopReason: "error", errorMessage: BARE_OVERFLOW_AS_SEEN });
		expect(diagnosticsOf(resumeFallback)).toContain(COLD_SEED_OVERFLOW_MARKER);
		// The full re-send and the rung-1 re-send (summary + 200 KB tail) were both rejected.
		expect(lane.requests.slice(4, 6).every((count) => count > CONTEXT_WINDOW)).toBe(true);
		// Rung 2 keeps only the summary; that re-send fits and the turn completes.
		const compactions = overflowCompactions(lane.harness);
		expect(compactions.filter((outcome) => outcome.accepted)).toHaveLength(2);
		expect(compactions.some((outcome) => /recovery failed after/.test(outcome.errorMessage ?? ""))).toBe(false);
		expect(lane.requests.at(-1)).toBeLessThanOrEqual(CONTEXT_WINDOW);
		expect(persisted.at(-1)).toMatchObject({ stopReason: "stop" });
	}, 30_000);

	it("gives the next prompt a fresh recovery budget after the ladder is exhausted (oh-my-openagent#8411)", async () => {
		const lane = await fakeLane({ keepRecentTokens: 40_000 });
		await buildLongHistory(lane);

		// Nothing fits while the fixed prefix alone exceeds the window: every rung is rejected.
		lane.api.fixedTokens = CONTEXT_WINDOW + 1;
		lane.breakResume();
		await lane.harness.session.prompt("second");
		const exhausted = overflowCompactions(lane.harness).find((outcome) =>
			/recovery failed after/.test(outcome.errorMessage ?? ""),
		);
		expect(exhausted).toBeDefined();
		expect(assistants(lane.harness).at(-1)).toMatchObject({ stopReason: "error" });
		const requestsBefore = lane.requests.length;

		// The user acts on the advice (here: the prefix shrinks again) and sends a message.
		lane.api.fixedTokens = 60_000;
		await lane.harness.session.prompt("third");

		// The prompt reached the provider instead of being refused by a stale latch.
		expect(lane.requests.length).toBeGreaterThan(requestsBefore);
		expect(assistants(lane.harness).at(-1)).toMatchObject({ stopReason: "stop" });
	}, 30_000);

	it("refuses a re-send before dispatch once the API's reported count has calibrated the gate", async () => {
		// The API wording that carries the count, as the SDK reports it.
		const lane = await fakeLane({
			keepRecentTokens: 40_000,
			wording: (count) =>
				`Prompt is too long · the request is ~${count} tokens (limit ${CONTEXT_WINDOW}) but this conversation is only ~${Math.floor(count / 3)} tokens — the rest is system prompt, tool definitions, and attachment content. A single-exchange conversation cannot be compacted; reduce attached files/tools or start with less context.`,
		});
		await buildLongHistory(lane);

		lane.breakResume();
		await lane.harness.session.prompt("second");

		// The full re-send was dispatched once and rejected with a count; from then on the lane
		// knows the API counts ~4x bytes/4 and refuses the rung-1 re-send without a round trip.
		const rejectedByApi = lane.requests.slice(4).filter((count) => count > CONTEXT_WINDOW);
		expect(rejectedByApi).toHaveLength(1);
		const refusedLocally = assistants(lane.harness).filter((message) =>
			/^The conversation is too long to resend/.test(message.errorMessage ?? ""),
		);
		expect(refusedLocally.length).toBeGreaterThanOrEqual(1);
		expect(assistants(lane.harness).at(-1)).toMatchObject({ stopReason: "stop" });
	}, 30_000);
});
