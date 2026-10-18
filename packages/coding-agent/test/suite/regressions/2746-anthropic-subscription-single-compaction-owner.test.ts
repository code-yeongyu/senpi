/**
 * senpi#2746: exactly one compaction owner per anthropic-subscription turn.
 *
 * senpi owns the lane's compaction by default (`compactionOwner: "sdk"` opts out). The owner is
 * fixed into the resident Claude Code process at spawn (`settings.autoCompactEnabled`), so a
 * mid-session change must restart that process before the next turn, and the compaction lane
 * policy must read the same live value. Otherwise one transcript gets two owners (or none).
 *
 * Drives a real AgentSession through the real provider stream, the resident session registry
 * and the real compaction extension against a scripted SDK that records each spawn's options.
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
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import {
	NATIVE_COMPACTION_WHILE_SENPI_OWNS,
	streamAnthropicSubscription,
} from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import {
	ANTHROPIC_SUBSCRIPTION_COMPACT_ENTRY_TYPE,
	createCompactionLanePolicy,
} from "../../../src/core/extensions/builtin/compaction/lane-policy.ts";
import {
	installAmbientLane,
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	type ScriptedResidentQuery,
	sdkMessage,
	streamEvent,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { createHarness, type Harness } from "../harness.ts";

const OWNER_ENV = "SENPI_CLAUDE_SDK_OAUTH_COMPACTION_OWNER";

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

const nativeCompactionThenAnswer =
	(text: string): Reply =>
	(sessionId, userUuid) => [
		sdkMessage({
			type: "system",
			subtype: "compact_boundary",
			session_id: sessionId,
			uuid: "native-boundary",
			compact_metadata: { trigger: "auto", pre_tokens: 190_000, post_tokens: 20_000 },
		}),
		...answer(text)(sessionId, userUuid),
	];

// With native auto-compact off, Claude Code rejects an over-limit resident turn instead of compacting it.
const promptTooLong: Reply = (sessionId) => [
	sdkMessage({
		type: "assistant",
		message: {
			id: "rejected",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "Prompt is too long" }],
		},
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

async function laneSession(replies: Reply[]) {
	await installSingleAccountLane();
	let call = 0;
	const queries = installScriptedSdk((sessionId, userUuid) => {
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
	harness.agent.sessionId = harness.sessionManager.getSessionId();
	const lanePolicy = createCompactionLanePolicy();
	const senpiOwns = () =>
		!lanePolicy.disablesSenpiCompaction({ cwd: process.cwd(), model: { provider: SCRIPTED_PROVIDER } });
	return { harness, queries, calls: () => call, senpiOwns };
}

/** The resident process that received the latest submission, i.e. the one that served the last turn. */
function servingQuery(queries: readonly ScriptedResidentQuery[]): ScriptedResidentQuery | undefined {
	return queries.filter((query) => query.submitted.length > 0).at(-1);
}

/** One owner, never zero: native auto-compact is on exactly when senpi stands down. */
function expectSingleOwner(query: ScriptedResidentQuery | undefined, senpiOwns: boolean): void {
	expect(query?.options?.settings).toEqual({ autoCompactEnabled: !senpiOwns });
}

function lastAssistant(harness: Harness): AssistantMessage | undefined {
	return [...harness.session.messages].reverse().find((message) => message.role === "assistant") as
		| AssistantMessage
		| undefined;
}

function mirroredNativeCompactions(harness: Harness): number {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === ANTHROPIC_SUBSCRIPTION_COMPACT_ENTRY_TYPE)
		.length;
}

describe("senpi#2746 one compaction owner per anthropic-subscription turn", () => {
	it("serves a default-owner turn from a resident process with native auto-compact and the token reminder off", async () => {
		const lane = await laneSession([answer("first answer")]);

		await lane.harness.session.prompt("first");

		const serving = servingQuery(lane.queries);
		expect(lane.senpiOwns()).toBe(true);
		expectSingleOwner(serving, true);
		expect(serving?.options?.env?.CLAUDE_CODE_TOTAL_TOKENS_REMINDER).toBe("off");
		// The overlay is layered over the auth lane's environment, never replacing it.
		expect(serving?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("access-primary");
		expect(lastAssistant(lane.harness)).toMatchObject({ stopReason: "stop" });
	}, 30_000);

	it.each([
		["sdk", "senpi"],
		["senpi", "sdk"],
	] as const)(
		"restarts the resident process when the owner flips from %s to %s mid-session",
		async (from, to) => {
			vi.stubEnv(OWNER_ENV, from);
			const lane = await laneSession([answer("first answer"), answer("second answer")]);

			await lane.harness.session.prompt("first");
			const first = servingQuery(lane.queries);
			expect(lane.senpiOwns()).toBe(from === "senpi");
			expectSingleOwner(first, from === "senpi");

			vi.stubEnv(OWNER_ENV, to);
			// The lane policy reads the change at once, with no reload and no cwd change.
			expect(lane.senpiOwns()).toBe(to === "senpi");
			await lane.harness.session.prompt("second");

			const second = servingQuery(lane.queries);
			expect(second).not.toBe(first);
			expect(first?.submitted).toHaveLength(1);
			expectSingleOwner(second, to === "senpi");
			expect(second?.options?.env?.CLAUDE_CODE_TOTAL_TOKENS_REMINDER).toBe(to === "senpi" ? "off" : undefined);
			expect(lane.calls()).toBe(2);
			expect(lastAssistant(lane.harness)).toMatchObject({ stopReason: "stop" });
		},
		30_000,
	);

	it("ends the turn with a clear error when senpi's overflow compaction fails, with no native compaction behind it", async () => {
		const lane = await laneSession([answer("first answer"), promptTooLong]);
		// Every attempt of senpi's own summary request (the faux model behind the same provider id)
		// fails with a retryable error, so the bounded retries run out and the compaction fails.
		lane.harness.setResponses(
			Array.from({ length: 8 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded: summary request failed" }),
			),
		);

		await lane.harness.session.prompt("first");
		await lane.harness.session.prompt("second");

		expect(lane.harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "overflow",
				errorMessage: expect.stringContaining("summary request failed"),
				result: undefined,
			}),
		]);
		expect(lastAssistant(lane.harness)).toMatchObject({ stopReason: "error" });
		expect(lastAssistant(lane.harness)?.errorMessage).toContain("Prompt is too long");
		// The failed turn is not handed to Claude Code again, and nothing compacted it natively.
		expect(lane.calls()).toBe(2);
		for (const query of lane.queries) expectSingleOwner(query, true);
		expect(mirroredNativeCompactions(lane.harness)).toBe(0);
	}, 30_000);

	it("stops the turn instead of mirroring a native compaction while senpi owns the lane", async () => {
		const lane = await laneSession([
			nativeCompactionThenAnswer("answer after a native compaction"),
			answer("answer from senpi's own history"),
		]);

		await lane.harness.session.prompt("first");

		const stopped = lastAssistant(lane.harness);
		expect(stopped).toMatchObject({ stopReason: "error" });
		expect(stopped?.errorMessage).toContain(NATIVE_COMPACTION_WHILE_SENPI_OWNS);
		expect(mirroredNativeCompactions(lane.harness)).toBe(0);
		const compacted = servingQuery(lane.queries);

		// The next turn must not resume the Claude Code session that just compacted natively:
		// it is rebuilt from senpi's own history in a fresh resident process.
		await lane.harness.session.prompt("second");

		const rebuilt = servingQuery(lane.queries);
		expect(rebuilt).not.toBe(compacted);
		expect(rebuilt?.options?.resume).toBeUndefined();
		expectSingleOwner(rebuilt, true);
		expect(lane.calls()).toBe(2);
		expect(lastAssistant(lane.harness)).toMatchObject({ stopReason: "stop" });
	}, 30_000);

	it("turns the token reminder off in the ambient lane's subprocess environment while senpi owns", async () => {
		// The host sets the reminder on: the lane-owned overlay must win over the ambient environment.
		installAmbientLane({ PATH: "/usr/bin", CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "on" });
		const queries = installScriptedSdk((sessionId, userUuid) => answer("ambient answer")(sessionId, userUuid));
		const harness = await createHarness({
			api: CLAUDE_SDK_OAUTH_API_ID,
			provider: SCRIPTED_PROVIDER,
			models: [{ id: "claude-test", contextWindow: 200_000 }],
			extensionFactories: [(pi) => registerSessionRegistry(pi), compactionExtension],
		});
		harnesses.push(harness);
		harness.agent.streamFunction = residentStreamFn;
		harness.agent.sessionId = harness.sessionManager.getSessionId();

		await harness.session.prompt("first");

		const serving = servingQuery(queries);
		expect(serving?.options?.env?.CLAUDE_CODE_TOTAL_TOKENS_REMINDER).toBe("off");
		// Still layered over the host environment, never replacing it.
		expect(serving?.options?.env?.PATH).toBe("/usr/bin");
		expect(serving?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expectSingleOwner(serving, true);
		expect(lastAssistant(harness)).toMatchObject({ stopReason: "stop" });
	}, 30_000);
});
