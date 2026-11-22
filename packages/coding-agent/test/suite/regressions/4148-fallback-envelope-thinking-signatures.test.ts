import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, prepareCompaction } from "../../../src/core/compaction/index.ts";
import {
	createRequiredCompactionFallback,
	type DeterministicFallbackDiagnostic,
} from "../../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#4148: the deterministic fallback prices each retained message at max(visible estimate, estimate of its
// JSON envelope). The envelope carried every opaque replay signature (thinking, text and tool-call signatures),
// which the visible estimate deliberately ignores, and the 4x base64 weight then priced a 16.8k-token suffix at
// 867k. Opaque signatures are not tokens the provider bills as context, so the envelope must not price them.

const WINDOW = 600_000;
const SIGNATURE = "Ab3+".repeat(2_125);

function signedAssistant(step: number) {
	return {
		...fauxAssistantMessage("", { stopReason: "toolUse", timestamp: 1_000 + step * 2 }),
		content: [
			...Array.from({ length: 13 }, (_, index) => ({
				type: "thinking" as const,
				thinking: `step ${step} thought ${index}`,
				thinkingSignature: SIGNATURE,
			})),
			{ type: "text" as const, text: `reading part ${step}`, textSignature: SIGNATURE },
			{
				type: "toolCall" as const,
				id: `read-${step}`,
				name: "read",
				arguments: { path: `part-${step}.log` },
				thoughtSignature: SIGNATURE,
			},
		],
	};
}

function signedSession() {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Investigate the synthetic logs", timestamp: 0 });
	for (let step = 0; step < 12; step++) {
		manager.appendMessage({
			...fauxAssistantMessage("", { stopReason: "toolUse", timestamp: step * 2 + 1 }),
			content: [{ type: "toolCall", id: `early-${step}`, name: "read", arguments: { path: "early.log" } }],
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: `early-${step}`,
			toolName: "read",
			content: [{ type: "text", text: `early ${step}: ${"synthetic log line\n".repeat(5_000)}` }],
			isError: false,
			timestamp: step * 2 + 2,
		});
	}
	for (let step = 0; step < 8; step++) {
		manager.appendMessage(signedAssistant(step));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: `read-${step}`,
			toolName: "read",
			content: [{ type: "text", text: `part ${step}: ok` }],
			isError: false,
			timestamp: 1_001 + step * 2,
		});
	}
	return manager;
}

describe("senpi#4148 fallback envelope does not price opaque signatures", () => {
	it("Given a retained suffix whose assistant turns carry long signatures when the fallback runs then the prepared boundary is accepted at its visible size", () => {
		// Given
		const manager = signedSession();
		const branch = manager.getBranch();
		const preparation = prepareCompaction(branch, DEFAULT_COMPACTION_SETTINGS, true);
		if (!preparation) throw new Error("Expected a compactable fixture");
		const visible = branch
			.slice(branch.findIndex((entry) => entry.id === preparation.firstKeptEntryId))
			.reduce((sum, entry) => sum + (entry.type === "message" ? estimateTokens(entry.message) : 0), 0);
		expect(visible).toBeLessThan(20_000);
		const diagnostics: DeterministicFallbackDiagnostic = {};

		// When
		const result = createRequiredCompactionFallback(
			preparation,
			WINDOW,
			"summarization-provider-failure",
			{},
			branch,
			diagnostics,
		);

		// Then
		expect(diagnostics.candidateRejections ?? []).toEqual([]);
		expect(result?.details?.retainedSuffix).toBe("prepared");
		expect(result?.firstKeptEntryId).toBe(preparation.firstKeptEntryId);
		expect(result?.estimatedTokensAfter).toBeLessThan(visible + 20_000);
	});
});
