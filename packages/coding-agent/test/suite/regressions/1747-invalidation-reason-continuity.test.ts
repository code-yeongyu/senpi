import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BINDING_ENTRY_TYPE } from "../../../src/core/extensions/builtin/anthropic-subscription/session-binding.ts";
import type { ContinuityObservation } from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { closeSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	assistant,
	type BranchEntry,
	cleanupRestartFixture,
	emit,
	fakeExtension,
	sessionFixture,
} from "../../helpers/anthropic-subscription-restart-fixture.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	sdkMessage,
	type TurnScript,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";

/**
 * senpi#1747: the ledger records WHY a binding was invalidated, and nothing ever
 * read that reason back. The next turn therefore reported the no-record default
 * `registry_miss` instead of the recorded cause.
 */

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const answerTurn: TurnScript = (sessionId, userUuid, submission) => [
	sdkMessage({
		type: "assistant",
		message: { id: `message-${userUuid}`, type: "message", role: "assistant", content: [] },
		parent_tool_use_id: null,
		uuid: `assistant-${userUuid}`,
		session_id: sessionId,
	}),
	sdkMessage({
		type: "result",
		subtype: "success",
		result: `answer-${submission}`,
		user_message_uuid: userUuid,
		uuid: `result-${userUuid}`,
		session_id: sessionId,
	}),
];

const conversation: Context = {
	messages: [
		{ role: "user", content: "turn one", timestamp: 1 },
		assistant("turn one answer"),
		{ role: "user", content: "turn two", timestamp: 3 },
	],
};

const sessionIds = new Set<string>();

function eventContext(sessionId: string, sessionFile: string, branch: BranchEntry[]): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getBranch: () => branch,
			getLeafId: () => branch[branch.length - 1]?.id ?? null,
		},
	} as unknown as ExtensionContext;
}

/** Restarts a session whose ledger may carry an invalidation record, then runs one turn. */
async function restartAndPrompt(sessionId: string, invalidation?: string): Promise<ContinuityObservation[]> {
	sessionIds.add(sessionId);
	const observed: ContinuityObservation[] = [];
	overrideContinuityObservabilityBoundary({ emit: (observation) => observed.push(observation) });
	await installSingleAccountLane();
	installScriptedSdk(answerTurn);
	const { sessionFile, branch } = sessionFixture();
	branch.push({ type: "message", id: "assistant-entry", message: assistant("turn one answer") });
	if (invalidation !== undefined) {
		branch.push({
			type: "custom",
			id: "binding-ledger",
			customType: BINDING_ENTRY_TYPE,
			data: { schemaVersion: 1, invalidated: true, reason: invalidation },
		});
	}
	const extension = fakeExtension(branch);
	registerSessionRegistry(extension.api);
	await emit(
		extension.handlers,
		"session_start",
		{ type: "session_start", reason: "resume" },
		eventContext(sessionId, sessionFile, branch),
	);
	await streamAnthropicSubscription(model, conversation, { sessionId, streamKind: "main" }).result();
	return observed;
}

afterEach(() => {
	for (const sessionId of sessionIds) {
		closeSession(sessionId, "test_cleanup");
		forgetBinding(sessionId);
	}
	sessionIds.clear();
	resetScriptedSdk();
	resetContinuityObservabilityBoundary();
	cleanupRestartFixture();
});

describe("issue #1747 recorded invalidation cause reaches the next turn", () => {
	it("names the recorded reason instead of registry_miss", async () => {
		const observed = await restartAndPrompt("issue-1747-recorded", "model_selected");

		expect(observed).toContainEqual(expect.objectContaining({ kind: "flatten", reason: "model_selected" }));
		expect(observed.map((observation) => observation.reason)).not.toContain("registry_miss");
	});

	it("still reports registry_miss when no invalidation was ever recorded", async () => {
		const observed = await restartAndPrompt("issue-1747-unrecorded");

		expect(observed).toContainEqual(expect.objectContaining({ kind: "flatten", reason: "registry_miss" }));
	});
});
