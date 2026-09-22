import { prepareToolArguments } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createEvalTool } from "../../../../senpi-codemode/src/tool/eval-tool.ts";
import { EVAL_SUMMARY_MAX_LENGTH } from "../../../../senpi-codemode/src/tool/types.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../../../src/core/extensions/builtin/anthropic-subscription/account-management.ts";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import { AssistantCommitBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/session-commit-boundary.ts";

const MODEL_ID = "claude-opus-5";
const UNUSED = () => Promise.reject(new Error("not reached: this regression only prepares arguments"));

const evalTool = createEvalTool({
	enabledLanguages: { js: true, py: false, rb: false, jl: false },
	kernelManager: { getKernel: UNUSED },
	cellTimeoutSeconds: 30,
	executeTool: UNUSED,
});

function evalAssistant(args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		api: CLAUDE_SDK_OAUTH_API_ID,
		provider: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
		model: MODEL_ID,
		content: [{ type: "toolCall", id: "call-1", name: "eval", arguments: args }],
		stopReason: "toolUse",
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function toolCallOf(message: AssistantMessage) {
	const block = message.content[0];
	if (block?.type !== "toolCall") throw new Error("fixture must start with an eval tool call");
	return block;
}

function runSummary(summary: string): Record<string, unknown> {
	return { language: "js", code: "return 1", summary };
}

// The provider streams the message, senpi prepares the same message's tool call for execution,
// and the commit boundary then fingerprints that message — so the regression drives one object
// through the real order rather than comparing two hand-written copies.
function commitAfterPreparing(message: AssistantMessage): { outcome: string; executed: Record<string, unknown> } {
	const boundary = new AssistantCommitBoundary();
	boundary.captureProviderFinal("session-1", message);
	const executed = prepareToolArguments(evalTool.prepareArguments, toolCallOf(message).arguments);
	return {
		outcome: boundary.commit("session-1", message, MODEL_ID),
		executed: executed as Record<string, unknown>,
	};
}

describe("issue #1472: preparing eval arguments must not break Claude SDK continuity", () => {
	it("commits an over-limit summary as clean and still clamps the executed arguments", () => {
		const summary = "s".repeat(EVAL_SUMMARY_MAX_LENGTH + 1);
		const message = evalAssistant(runSummary(summary));

		const { outcome, executed } = commitAfterPreparing(message);

		expect(outcome).toBe("clean");
		expect(toolCallOf(message).arguments.summary).toBe(summary);
		expect(executed.summary).toHaveLength(EVAL_SUMMARY_MAX_LENGTH);
		expect(executed.summary).toMatch(/\.\.\.$/);
	});

	it("leaves a summary at the limit untouched on both sides", () => {
		const summary = "s".repeat(EVAL_SUMMARY_MAX_LENGTH);
		const message = evalAssistant(runSummary(summary));

		const { outcome, executed } = commitAfterPreparing(message);

		expect(outcome).toBe("clean");
		expect(toolCallOf(message).arguments.summary).toBe(summary);
		expect(executed.summary).toBe(summary);
	});

	it("commits a control action as clean without inventing a summary", () => {
		const message = evalAssistant({ action: "peek", cell_id: "cell-1" });

		const { outcome } = commitAfterPreparing(message);

		expect(outcome).toBe("clean");
		expect(toolCallOf(message).arguments).toEqual({ action: "peek", cell_id: "cell-1" });
	});

	it("still reports a genuine summary rewrite as rewritten", () => {
		const message = evalAssistant(runSummary("inspect the cache state"));
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("session-1", message);

		toolCallOf(message).arguments.summary = "delete the cache state";

		expect(boundary.commit("session-1", message, MODEL_ID)).toBe("rewritten");
	});

	it("still reports a genuine code rewrite as rewritten", () => {
		const message = evalAssistant(runSummary("inspect the cache state"));
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("session-1", message);

		toolCallOf(message).arguments.code = "return 2";

		expect(boundary.commit("session-1", message, MODEL_ID)).toBe("rewritten");
	});
});
