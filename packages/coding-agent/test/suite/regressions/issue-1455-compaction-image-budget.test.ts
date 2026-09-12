import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../../src/core/compaction/index.ts";
import {
	createRequiredCompactionFallback,
	type DeterministicFallbackDiagnostic,
} from "../../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createCompactionImage } from "./issue-1455-image-fixture.ts";

const image = createCompactionImage();
const RESERVE_TOKENS = 100;

function createCase(content: ToolResultMessage["content"], args: Record<string, unknown> = {}) {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Inspect the image.", timestamp: 1 });
	const boundary = manager.appendMessage({
		...fauxAssistantMessage("", { timestamp: 2, stopReason: "toolUse" }),
		content: [{ type: "toolCall", id: "read-image", name: "read", arguments: args }],
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "read-image",
		toolName: "read",
		content,
		isError: false,
		timestamp: 3,
	});
	const branch = manager.getBranch();
	const preparation = prepareCompaction(
		branch,
		{ ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: RESERVE_TOKENS, reserveScalingEnabled: false },
		true,
	);
	if (!preparation) throw new Error("Expected a compaction preparation for the fixture");
	return {
		manager,
		boundary,
		branch,
		run(contextWindow = 1_000_000) {
			const diagnostics: DeterministicFallbackDiagnostic = {};
			const result = createRequiredCompactionFallback(
				{ ...preparation, firstKeptEntryId: boundary },
				contextWindow,
				"summarization-timeout",
				{},
				branch,
				diagnostics,
			);
			return { result, diagnostics };
		},
	};
}

describe("issue #1455: retained image token budgeting", () => {
	it("retains a realistic PNG at the prepared boundary without changing its payload", () => {
		// Given: #1455 has a valid image whose base64 exceeds the token window.
		const fixture = createCase([image]);
		const original = JSON.stringify(fixture.branch);
		expect(image.data.length).toBeGreaterThan(1_000_000);

		// When: required compaction must recover without another model call.
		const { result } = fixture.run();

		// Then: the original tool chain is admitted, not an image-free replacement.
		expect(result).toMatchObject({
			firstKeptEntryId: fixture.boundary,
			details: { retainedSuffix: "prepared" },
		});
		expect(JSON.stringify(fixture.branch)).toBe(original);
	});

	it("charges the same image tokens independently of Base64 payload size", () => {
		// Given: only the image payload differs between the two valid PNGs.
		const tiny = {
			...image,
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1EAAAAASUVORK5CYII=",
		};
		const expected = createCase([tiny]).run().result;
		if (!expected) throw new Error("Expected the tiny image control to fit");

		// When: the larger PNG goes through the same admission policy.
		const { result } = createCase([image]).run();

		// Then: storage bytes do not change its token charge.
		expect(result?.estimatedTokensAfter).toBe(expected.estimatedTokensAfter);
	});

	it("rejects genuinely excessive image-token accumulation", () => {
		// Given: eight images require 9,600 tokens before envelope and summary costs.
		const fixture = createCase(Array.from({ length: 8 }, () => ({ ...image })));

		// When: the complete suffix has a 9,900-token admission budget.
		const { result, diagnostics } = fixture.run(10_000);

		// Then: removing Base64 from token accounting does not make images free.
		expect(result).toBeUndefined();
		expect(diagnostics.budgetExceeded).toBe(true);
	});

	it("keeps image costs additive when the serialized text floor dominates", () => {
		// Given: prose whose serialized bytes exceed its chars/4 estimate, so the byte
		// floor (not the ordinary estimator) decides admission. An unbroken alphanumeric
		// run would trip the base64-run weighting and let the estimator dominate instead.
		const text = { type: "text" as const, text: "lorem ipsum dolor sit amet ".repeat(400) };
		const control = createCase([text]).run().result;
		if (control?.estimatedTokensAfter === undefined) throw new Error("Expected the text-only control to fit");
		// Headroom below one image charge (1,200 tokens) but above the image block's
		// non-payload envelope bytes, so only the image token charge can tip the budget.
		const contextWindow = control.estimatedTokensAfter + RESERVE_TOKENS + 600;
		expect(createCase([text]).run(contextWindow).result).toBeDefined();
		const fixture = createCase([text, image]);

		// When: that same text is accompanied by a valid image.
		const { result, diagnostics } = fixture.run(contextWindow);

		// Then: the image charge cannot disappear behind max(text bytes, estimated tokens).
		expect(result).toBeUndefined();
		expect(diagnostics.budgetExceeded).toBe(true);
	});

	it("does not exempt image-shaped objects inside tool-call arguments", () => {
		// Given: this data is an argument, not a provider image content block.
		const fixture = createCase([{ type: "text", text: "ok" }], { snapshot: image });

		// When: its serialized argument payload exceeds the context budget.
		const { result, diagnostics } = fixture.run();

		// Then: the conservative non-image bound remains in force.
		expect(result).toBeUndefined();
		expect(diagnostics.budgetExceeded).toBe(true);
	});

	it("keeps unrelated image metadata charged even when it duplicates the payload", () => {
		// Given: only the actual data field represents the image payload.
		const withMetadata = { ...image, thumbnail: image.data };
		const fixture = createCase([withMetadata]);

		// When: the extra field alone is larger than the token budget.
		const { result, diagnostics } = fixture.run();

		// Then: the image exclusion must not reach arbitrary nested or sibling values.
		expect(result).toBeUndefined();
		expect(diagnostics.budgetExceeded).toBe(true);
	});

	it("preserves the conservative bound for large escaped non-image text", () => {
		// Given: JSON escapes expand this ordinary text substantially.
		const fixture = createCase([{ type: "text", text: '\u0000"\\'.repeat(100_000) }]);

		// When: the serialized non-image content exceeds a small context window.
		const { result, diagnostics } = fixture.run(100_000);

		// Then: image-aware sizing does not weaken non-image overflow protection.
		expect(result).toBeUndefined();
		expect(diagnostics.budgetExceeded).toBe(true);
	});
});
