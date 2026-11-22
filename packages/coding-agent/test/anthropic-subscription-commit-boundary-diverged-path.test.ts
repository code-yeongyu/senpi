import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AssistantCommitBoundary } from "../src/core/extensions/builtin/anthropic-subscription/session-commit-boundary.ts";

/**
 * senpi#1975: an `assistant_rewritten` decision must name the FIRST diverged
 * field path of the semantic projection (paths only, never values), and that
 * path must travel with the decision: the binding-invalidation ledger record,
 * the pending-fork record on the registry entry, the continuity observation,
 * and the session.log continuity event.
 */

const MODEL_ID = "claude-test";
const SUMMARY_92 = `eval finished in 41.2s with 3 tool calls${"x".repeat(50)}Z9`;
const SUMMARY_80 = SUMMARY_92.slice(0, 80);

function assistantWith(content: AssistantMessage["content"], model = MODEL_ID): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model,
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
	};
}

function toolCallAssistant(summary: string): AssistantMessage {
	return assistantWith([{ type: "toolCall", id: "toolu_eval", name: "eval", arguments: { summary } }]);
}

describe("issue #1975: assistant_rewritten names the first diverged path", () => {
	it("names the clamped toolCall summary path and never carries the value", () => {
		expect(SUMMARY_92).toHaveLength(92);
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("clamp", toolCallAssistant(SUMMARY_92));

		const result = boundary.commit("clamp", toolCallAssistant(SUMMARY_80), MODEL_ID);

		expect(result).toEqual({ outcome: "rewritten", divergedPath: "content[0].arguments.summary" });
		expect(JSON.stringify(result)).not.toContain("Z9");
		expect(JSON.stringify(result)).not.toContain(SUMMARY_80.slice(0, 40));
	});

	it("names the path when a shim mutates the captured arguments in place (#1472 class)", () => {
		const boundary = new AssistantCommitBoundary();
		const streamed = toolCallAssistant(SUMMARY_80);
		boundary.captureProviderFinal("in-place", streamed);

		// A shim mutating the same object after capture is the original #1472
		// defect shape: a referenced projection would follow the mutation.
		if (streamed.content[0]?.type !== "toolCall") throw new Error("expected a toolCall block");
		streamed.content[0].arguments.summary = SUMMARY_92;

		expect(boundary.commit("in-place", streamed, MODEL_ID)).toEqual({
			outcome: "rewritten",
			divergedPath: "content[0].arguments.summary",
		});
	});

	it("keeps a clean commit path-free", () => {
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("clean", toolCallAssistant(SUMMARY_80));

		expect(boundary.commit("clean", toolCallAssistant(SUMMARY_80), MODEL_ID)).toStrictEqual({ outcome: "clean" });
	});

	it("keeps a non-resident commit path-free", () => {
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("foreign", toolCallAssistant(SUMMARY_80));

		expect(boundary.commit("foreign", toolCallAssistant(SUMMARY_80), "claude-other")).toStrictEqual({
			outcome: "not-resident",
		});
	});

	it.each([
		[
			"content.length",
			[
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
			[{ type: "text", text: "a" }],
		],
		["content[0].type", [{ type: "text", text: "a" }], [{ type: "thinking", thinking: "a" }]],
		["content[0].text", [{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
		[
			"content[0].thinking",
			[{ type: "thinking", thinking: "a", thinkingSignature: "s" }],
			[{ type: "thinking", thinking: "b", thinkingSignature: "s" }],
		],
		[
			"content[0].thinkingSignature",
			[{ type: "thinking", thinking: "a", thinkingSignature: "s1" }],
			[{ type: "thinking", thinking: "a", thinkingSignature: "s2" }],
		],
		[
			"content[1].id",
			[
				{ type: "text", text: "a" },
				{ type: "toolCall", id: "t1", name: "eval", arguments: { summary: "s" } },
			],
			[
				{ type: "text", text: "a" },
				{ type: "toolCall", id: "t2", name: "eval", arguments: { summary: "s" } },
			],
		],
		[
			"content[0].name",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { summary: "s" } }],
			[{ type: "toolCall", id: "t1", name: "read", arguments: { summary: "s" } }],
		],
		[
			"content[0].arguments.data.label",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { data: { label: "a" } } }],
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { data: { label: "b" } } }],
		],
		[
			"content[0].arguments.items[1]",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { items: ["a", "b"] } }],
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { items: ["a", "c"] } }],
		],
		[
			"content[0].arguments.items[1]",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { items: ["a"] } }],
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { items: ["a", "c"] } }],
		],
		[
			"content[0].arguments.<key#1>",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { a: "x", "b.c[0]": "y" } }],
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { a: "x", "b.c[0]": "z" } }],
		],
		[
			"content[0].arguments.<key#0>",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { ["k".repeat(65)]: "x" } }],
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { ["k".repeat(65)]: "y" } }],
		],
		["model", [{ type: "text", text: "a" }], [{ type: "text", text: "a" }]],
	] as const)("names %s first", (path, providerContent, committedContent) => {
		const boundary = new AssistantCommitBoundary();
		// The residency check gates the walk, so a model drift must sit on the
		// provider-final side for the committed message to stay resident.
		const providerModel = path === "model" ? "claude-other" : MODEL_ID;
		boundary.captureProviderFinal("walk", assistantWith([...providerContent], providerModel));

		const result = boundary.commit("walk", assistantWith([...committedContent]), MODEL_ID);

		expect(result).toEqual({ outcome: "rewritten", divergedPath: path });
	});
});
