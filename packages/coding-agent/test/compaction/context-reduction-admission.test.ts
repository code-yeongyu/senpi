import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, expect, it } from "vitest";
import { buildCompactionContext } from "../../src/core/extensions/builtin/compaction/context-pipeline.ts";
import { createContextReductionState } from "../../src/core/extensions/builtin/compaction/context-reduction-state.ts";
import { createEmergencyPruneLatch } from "../../src/core/extensions/builtin/compaction/emergency-prune.ts";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

it.each([false, true])(
	"requires recovery before engagement only when emergency pruning rewrites: %s",
	async (prunable) => {
		harness = await createHarness();
		const state = createContextReductionState();
		const messages: AgentMessage[] = [{ role: "user", content: "old ".repeat(120_000), timestamp: 0 }];
		if (prunable) messages.push({ role: "user", content: "Current request", timestamp: 1 });
		const latch = createEmergencyPruneLatch();
		const outgoing = buildCompactionContext({
			event: { type: "context", messages },
			ctx: harness.getExtensionRunner().createContext(),
			contextWindow: 100_000,
			promptContextWindow: 96_000,
			contextReductionState: state,
			toolAdmissionEnabled: false,
			breakerFallback: false,
			laneOwnsCompaction: false,
			emergencyPruneLatch: latch,
		});
		expect(latch.engaged).toBe(true);
		expect(state.engaged).toBe(false);
		expect(state.anchorCount).toBeUndefined();
		expect(estimateTotalTokens(outgoing) < 96_000).toBe(prunable);
		expect(state.compactionRequired === true).toBe(prunable);
	},
);
