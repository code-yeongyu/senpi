import { expect, it, vi } from "vitest";
import { buildCompactionContext } from "../../src/core/extensions/builtin/compaction/context-pipeline.ts";
import { createEmergencyPruneLatch } from "../../src/core/extensions/builtin/compaction/emergency-prune.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { createReductionHarness, reductionSeed } from "../support/context-reduction-fixture.ts";
import { OPENAI_NATIVE_LEGACY_MODEL } from "./openai-remote-test-models.ts";

const window = 100_000;

it("bypasses the native latch but preserves its breaker fallback", async () => {
	const { h } = await createReductionHarness();
	try {
		const messages = reductionSeed();
		const ctx = h.getExtensionRunner().createContext();
		for (const lane of ["native", "external", "append-only"]) {
			const state = { engaged: true, cutIndex: 5, prefixHash: "already-engaged" };
			const outgoing = buildCompactionContext({
				event: { type: "context", messages },
				ctx: { ...ctx, model: lane === "native" ? OPENAI_NATIVE_LEGACY_MODEL : h.getModel() },
				contextWindow: window,
				promptContextWindow: window,
				contextReductionState: state,
				toolAdmissionEnabled: false,
				breakerFallback: lane !== "native",
				laneOwnsCompaction: lane === "external",
				appendOnlyTranscript: lane === "append-only",
				emergencyPruneLatch: createEmergencyPruneLatch(),
			});
			expect(JSON.stringify(outgoing)).toBe(JSON.stringify(convertToLlm(messages)));
			expect(state).toEqual({ engaged: true, cutIndex: 5, prefixHash: "already-engaged" });
		}
		const state = { engaged: true, cutIndex: 5, prefixHash: "already-engaged" };
		const fallback = buildCompactionContext({
			event: { type: "context", messages },
			ctx: { ...ctx, model: OPENAI_NATIVE_LEGACY_MODEL },
			contextWindow: window,
			promptContextWindow: window,
			contextReductionState: state,
			toolAdmissionEnabled: false,
			breakerFallback: true,
			laneOwnsCompaction: false,
			emergencyPruneLatch: createEmergencyPruneLatch(),
		});
		expect(JSON.stringify(fallback)).not.toBe(JSON.stringify(convertToLlm(messages)));
		expect(state).toEqual({ engaged: true, cutIndex: 5, prefixHash: "already-engaged" });
	} finally {
		vi.restoreAllMocks();
		h.cleanup();
	}
});
