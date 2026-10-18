import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, getCurrentTools, wrapStreamWithModelRecovery } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import { decideNativeContinuity } from "../../../src/core/extensions/builtin/anthropic-subscription/session-continuity.ts";
import { getSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	sdkMessage,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	resetScriptedSdk();
});

describe("manual compaction on the Claude subscription lane", () => {
	it.each(["pendingForkReason", "taintedReason"] as const)(
		"cold-seeds compacted history rather than preserving an SDK prefix via %s",
		(reasonField) => {
			const fingerprint = { systemPromptHash: "prompt", toolsetHash: "tools" };
			const decision = decideNativeContinuity({
				entry: {
					sdkSessionId: "old-sdk-session",
					accountName: "primary",
					modelId: "claude-test",
					...fingerprint,
					sentCount: 3,
					sentHashes: ["old-1", "old-2", "old-3"],
					lastAssistantUuid: "assistant-3",
					assistantUuidByIndex: new Map([
						[1, "assistant-1"],
						[2, "assistant-2"],
						[3, "assistant-3"],
					]),
					pendingForkReason: null,
					[reasonField]: "compaction",
				},
				binding: undefined,
				currentHashes: ["summary", "kept", "next"],
				accountName: "primary",
				modelId: "claude-test",
				fingerprint,
				transcriptAvailable: true,
				crossAccountResumeSupported: true,
			});

			expect(decision).toEqual({ kind: "flatten", reason: "tainted_compaction" });
		},
	);

	it("starts a fresh SDK transcript with the summary after accepted manual compaction", async () => {
		await installSingleAccountLane();
		const queries = installScriptedSdk((sessionId, userUuid, submission) => [
			sdkMessage({
				type: "assistant",
				uuid: `assistant-${submission}`,
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					id: `message-${submission}`,
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: `answer-${submission}` }],
					stop_reason: "end_turn",
					usage: { input_tokens: 10, output_tokens: 4 },
				},
			}),
			sdkMessage({
				type: "result",
				subtype: "success",
				result: `answer-${submission}`,
				user_message_uuid: userUuid,
				session_id: sessionId,
				usage: { input_tokens: 10, output_tokens: 4 },
			}),
		]);
		harness = await createHarness({
			api: CLAUDE_SDK_OAUTH_API_ID,
			provider: SCRIPTED_PROVIDER,
			models: [{ id: "claude-test", contextWindow: 200_000 }],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [(pi) => registerSessionRegistry(pi), compactionExtension],
		});
		const residentStream: StreamFn = (model, context, options) =>
			wrapStreamWithModelRecovery(
				streamAnthropicSubscription(model, context, options),
				model,
				getCurrentTools(context.messages),
			);
		harness.agent.streamFunction = residentStream;
		const sessionId = harness.sessionManager.getSessionId();
		harness.agent.sessionId = sessionId;
		const discarded = "discarded-history-fixture ".repeat(400);
		await harness.session.prompt(discarded);
		await harness.session.prompt("kept-history-fixture");
		const before = getSession(sessionId);
		expect(before?.assistantUuidByIndex.size).toBe(2);
		const oldSdkSessionId = before?.sdkSessionId;
		harness.setResponses([fauxAssistantMessage("summary-fixture")]);

		await harness.session.compact();
		await harness.session.prompt("next-turn-fixture");

		expect(getSession(sessionId)?.sdkSessionId).not.toBe(oldSdkSessionId);
		expect(queries).toHaveLength(2);
		const payload = getMessageText(queries[1]?.submitted[0]?.message);
		expect(payload).toContain("summary-fixture");
		expect(payload).not.toContain(discarded);
	});
});
