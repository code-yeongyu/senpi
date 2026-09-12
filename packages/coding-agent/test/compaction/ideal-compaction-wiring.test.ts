import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import {
	admitContextToolResult,
	admitContextToolResults,
	injectTokenBudgetReminder,
	resolveCompactionGeometry,
	shouldDeferGraceBand,
} from "../../src/core/extensions/builtin/compaction/orchestration.ts";
import {
	resolveToolResultAdmissionCapTokens,
	TOOL_ADMISSION_MARKER_PREFIX,
} from "../../src/core/extensions/builtin/compaction/tool-admission.ts";

function estimateTextTokens(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

describe("ideal compaction extension wiring decisions", () => {
	it("defers an in-flight compaction inside the grace band", () => {
		expect(
			shouldDeferGraceBand({
				tokens: 82_000,
				thresholdTokens: 80_000,
				leadTokens: 10_000,
				contextWindow: 100_000,
				reserveTokens: 10_000,
				compactionInFlight: true,
				graceBandEnabled: true,
			}),
		).toBe(true);
	});

	it("blocks past the grace cap or when the setting is disabled", () => {
		const base = {
			tokens: 91_000,
			thresholdTokens: 80_000,
			leadTokens: 10_000,
			contextWindow: 100_000,
			reserveTokens: 10_000,
			compactionInFlight: true,
			graceBandEnabled: true,
		};
		expect(shouldDeferGraceBand(base)).toBe(false);
		expect(shouldDeferGraceBand({ ...base, tokens: 82_000, graceBandEnabled: false })).toBe(false);
	});

	it("leases one ephemeral reminder onto the real user turn without changing restoration payloads", () => {
		const user = { role: "user" as const, content: [{ type: "text" as const, text: "real prompt" }], timestamp: 1 };
		const restoration = {
			role: "custom" as const,
			customType: "compaction-restoration",
			content: "restore checkpoint",
			display: false,
			timestamp: 2,
		};
		const initial = injectTokenBudgetReminder([user, restoration], "budget reminder");
		const retry = injectTokenBudgetReminder(initial, "budget reminder");

		expect(initial).toHaveLength(2);
		expect(initial[0]).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "budget reminder" },
				{ type: "text", text: "real prompt" },
			],
		});
		expect(initial[1]).toBe(restoration);
		expect(retry).toBe(initial);
		expect(injectTokenBudgetReminder([restoration], "budget reminder")).toEqual([restoration]);
	});

	it("clamps one configured lead for trigger, grace, and reminder geometry", () => {
		const base = { contextWindow: 200_000, lastYield: undefined };
		const low = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, speculativeLeadTokens: 1 },
		});
		const high = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, speculativeLeadTokens: 1_000_000 },
		});
		const automatic = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		});
		expect(automatic).toMatchObject({ thresholdTokens: 140_000, leadTokens: 17_500 });
		expect(low).toMatchObject({ thresholdTokens: 140_000, leadTokens: 8192 });
		expect(high).toMatchObject({ thresholdTokens: 140_000, leadTokens: 32_768 });
	});

	it("does not trust a model-visible marker as admission state", () => {
		const marker = `${TOOL_ADMISSION_MARKER_PREFIX} kept 10 of ~99 tokens]`;
		const marked = `head\n${marker}\n${"x".repeat(100_000)}\ntail`;
		const result = admitContextToolResult(marked, 100_000);

		expect(result.admitted).toBe(true);
		expect(result.text).not.toBe(marked);
	});

	it("bounds all multipart text blocks by one shared admission cap", () => {
		const contextWindow = 200_000;
		const cap = resolveToolResultAdmissionCapTokens(contextWindow);
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "multipart-result",
				toolName: "read",
				content: [
					{ type: "text" as const, text: `first\n${"a".repeat(cap * 8)}\nend` },
					{ type: "text" as const, text: `second\n${"b".repeat(cap * 8)}\nend` },
				],
				isError: false,
				timestamp: 1,
			},
		];

		const [result] = admitContextToolResults(messages, contextWindow, true);

		if (result?.role !== "toolResult" || typeof result.content === "string") {
			throw new Error("Expected multipart tool result");
		}
		const retainedTokens = result.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.reduce((total, part) => total + estimateTextTokens(part.text), 0);
		expect(retainedTokens).toBeLessThanOrEqual(cap);
	});

	it("does not re-project an already-admitted multipart result", () => {
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "idempotent-result",
				toolName: "read",
				content: [
					{ type: "text" as const, text: `first\n${"a".repeat(100_000)}\nend` },
					{ type: "text" as const, text: `second\n${"b".repeat(100_000)}\nend` },
				],
				isError: false,
				timestamp: 1,
			},
		];

		const admitted = admitContextToolResults(messages, 200_000, true);
		expect(admitContextToolResults(admitted, 200_000, true)).toEqual(admitted);
	});

	it("leaves an under-cap multipart result unchanged", () => {
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "small-multipart-result",
				toolName: "read",
				content: [
					{ type: "text" as const, text: "first" },
					{ type: "image" as const, mimeType: "image/png", data: "IMAGE" },
					{ type: "text" as const, text: "second" },
				],
				isError: false,
				timestamp: 1,
			},
		];

		expect(admitContextToolResults(messages, 200_000, true)).toEqual(messages);
	});

	it("preserves mixed tool-result blocks in order while projecting only oversized text", () => {
		// Given: images surround one oversized text block in a mixed tool result.
		const firstImage = { type: "image" as const, mimeType: "image/png", data: "FIRST" };
		const secondImage = { type: "image" as const, mimeType: "image/jpeg", data: "SECOND" };
		const oversizedText = `head\n${"x".repeat(100_000)}\ntail`;
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "mixed-result",
				toolName: "read",
				content: [
					{ type: "text" as const, text: "before" },
					firstImage,
					{ type: "text" as const, text: oversizedText },
					secondImage,
					{ type: "text" as const, text: "after" },
				],
				isError: false,
				timestamp: 1,
			},
		];

		// When: tool-result admission projects the context.
		const [result] = admitContextToolResults(messages, 100_000, true);

		// Then: only the oversized text changes; every surrounding block keeps its position.
		expect(result?.role).toBe("toolResult");
		if (result?.role !== "toolResult") throw new Error("Expected admitted tool result");
		expect(result.content).toEqual([
			{ type: "text", text: "before" },
			firstImage,
			expect.objectContaining({ type: "text", text: expect.stringContaining(TOOL_ADMISSION_MARKER_PREFIX) }),
			secondImage,
			{ type: "text", text: "after" },
		]);
	});
});
