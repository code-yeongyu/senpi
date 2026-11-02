import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { reduceContextWithFrontier } from "../../src/core/extensions/builtin/compaction/context-reduction-frontier.ts";
import { createContextReductionState } from "../../src/core/extensions/builtin/compaction/context-reduction-state.ts";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { resultPair, textAssistant } from "../support/context-reduction-fixture.ts";

/**
 * SIMULATED, not measured (senpi#3242): a deterministic model of Anthropic prompt caching replays a
 * long tool loop on a 1M window. Cache entries exist only at breakpoints; a breakpoint reads the
 * longest entry at or up to LOOKBACK messages before it; writes are billed from that hit to the
 * breakpoint. Prices follow the member's 1-hour TTL report: write 2.0, read 0.1, input-price units.
 */
const LOOKBACK = 20;
const WRITE = 2.0;
const READ = 0.1;
const SYSTEM_TOKENS = 30_000;
const WINDOW = 1_000_000;
const COMPACTION_AT = 0.8;

type Totals = { write: number; read: number; steps: number; stepWrites: { write: number; context: number }[] };

function history(): AgentMessage[] {
	const names = ["read", "bash", "write", "eval", "grep"];
	const messages: AgentMessage[] = [{ role: "user", content: "task ".repeat(8_000), timestamp: 0 } as AgentMessage];
	for (let index = 0; messages.length < 1_400; index++) {
		messages.push(
			...(resultPair(index + 1, names[index % names.length], 600 + ((index * 37) % 1_400)) as AgentMessage[]),
		);
		if (index % 20 === 19) messages.push(textAssistant(100_000 + index, 400) as AgentMessage);
	}
	return messages;
}

function strip(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant" || !("promptCacheBreakpoint" in message)) return message;
	const { promptCacheBreakpoint: _hint, ...rest } = message;
	return rest as AgentMessage;
}

/** Replays one compaction segment; `reduce` false keeps the transcript append-only. */
function replay(all: AgentMessage[], reduce: boolean): Totals {
	const entries = new Set<string>();
	const state = createContextReductionState();
	const totals: Totals = { write: 0, read: 0, steps: 0, stepWrites: [] };
	let previousCut = 0;
	for (let length = 3; length <= all.length; length += 2) {
		const unreduced = all.slice(0, length);
		if (estimateTotalTokens(unreduced) + SYSTEM_TOKENS > WINDOW * COMPACTION_AT) break;
		const sent = reduce
			? reduceContextWithFrontier(unreduced, state, {
					unreducedMessages: unreduced,
					contextWindow: WINDOW,
					ceilingTokens: WINDOW,
					overheadTokens: SYSTEM_TOKENS,
					force: false,
				})
			: unreduced;
		const step = state.cutIndex !== previousCut && previousCut > 0;
		if (state.cutIndex !== previousCut) totals.steps++;
		previousCut = state.cutIndex;
		const writeBefore = totals.write;
		// Prefix hashes and cumulative tokens per message boundary; position 0 is the system prompt.
		const hashes: string[] = [];
		const tokens: number[] = [SYSTEM_TOKENS];
		const hash = createHash("sha256").update("system");
		hashes.push(hash.copy().digest("hex"));
		for (const message of sent) {
			hash.update(JSON.stringify(strip(message)));
			hashes.push(hash.copy().digest("hex"));
			tokens.push(tokens[tokens.length - 1] + estimateTotalTokens([strip(message)]));
		}
		// Breakpoints: system, each marked message (the adapter allows two when the system holds one),
		// then the last message; without markers the preceding tool-loop checkpoint is kept.
		const marked = sent.flatMap((message, index) =>
			message.role === "assistant" && "promptCacheBreakpoint" in message ? [index + 1] : [],
		);
		const breakpoints =
			marked.length > 0 ? [0, ...marked.slice(0, 2), sent.length] : [0, Math.max(0, sent.length - 2), sent.length];
		let covered = 0;
		for (const breakpoint of breakpoints) {
			let hit = 0;
			for (let position = breakpoint; position >= Math.max(0, breakpoint - LOOKBACK); position--) {
				if (entries.has(hashes[position])) {
					hit = tokens[position];
					break;
				}
			}
			if (hit > covered) {
				totals.read += hit - covered;
				covered = hit;
			}
			if (tokens[breakpoint] > covered) {
				totals.write += tokens[breakpoint] - covered;
				covered = tokens[breakpoint];
			}
			entries.add(hashes[breakpoint]);
		}
		if (step) totals.stepWrites.push({ write: totals.write - writeBefore, context: tokens[sent.length] });
	}
	return totals;
}

function price(totals: Totals): number {
	return totals.write * WRITE + totals.read * READ;
}

describe("context reduction cache replay (SIMULATED, senpi#3242)", () => {
	it("a frontier step re-writes only what changed, so reduction costs less than an append-only transcript", () => {
		const all = history();
		const appendOnly = replay(all, false);
		const reduced = replay(all, true);
		console.log(
			JSON.stringify({ appendOnly, reduced, appendOnlyPrice: price(appendOnly), reducedPrice: price(reduced) }),
		);
		expect(reduced.stepWrites.length).toBeGreaterThan(1);
		// A step after the first re-writes what changed (the newly reduced block and the tail), not the
		// whole conversation from the system prompt.
		for (const step of reduced.stepWrites) expect(step.write).toBeLessThan(step.context * 0.35);
		expect(price(reduced)).toBeLessThanOrEqual(price(appendOnly));
	}, 120_000);
});
