import { describe, expect, it } from "vitest";
import {
	contextBudgetOutcome,
	EFFECT_OUTCOMES,
	providerUnavailableOutcome,
	turnErrorOutcome,
	unknownModelOutcome,
	unsupportedThinkingLevelOutcome,
} from "../../src/modes/rpc/effect-outcome-copy.ts";
import { EffectIdConflict } from "../../src/modes/rpc/effect-record.ts";
import { TranscriptUnreadable } from "../../src/modes/rpc/effect-transcript-lookup.ts";

// Every failure kind the effect ledger can answer carries a machine code, plain words, and an action the
// caller can take; the reopen of an abort is the one kind with no action, because the abort's goal holds.
describe("effect outcome copy", () => {
	const actionable = [
		["interrupted_by_reopen", EFFECT_OUTCOMES.inputInterruptedByReopen],
		["dropped_by_replace", EFFECT_OUTCOMES.inputDroppedByReplace],
		["interrupted_by_reopen", EFFECT_OUTCOMES.setModelInterruptedByReopen],
		["interrupted_by_reopen", EFFECT_OUTCOMES.setThinkingInterruptedByReopen],
		["superseded", EFFECT_OUTCOMES.setModelSuperseded],
		["context_budget", contextBudgetOutcome("the target cannot hold the fixed prefix")],
		["interrupted_by_reopen", EFFECT_OUTCOMES.dequeueInterruptedByReopen],
		["unknown_model", unknownModelOutcome("faux", "missing")],
		["provider_unavailable", providerUnavailableOutcome("no credentials for faux")],
		["unsupported_thinking_level", unsupportedThinkingLevelOutcome("xhigh is not supported by faux-1")],
		["error", turnErrorOutcome("upstream 500")],
		["error", turnErrorOutcome(undefined)],
	] as const;

	it.each(actionable)("renders %s with a reason, plain detail and an action", (code, outcome) => {
		expect(outcome).toMatchObject({ kind: code, reason: code });
		expect(outcome.detail?.trim().length).toBeGreaterThan(0);
		expect(outcome.action?.trim().length).toBeGreaterThan(0);
	});

	it("tells a caller to mint a new id wherever retrying under the old id would replay the failure", () => {
		for (const outcome of [
			EFFECT_OUTCOMES.setModelInterruptedByReopen,
			EFFECT_OUTCOMES.setThinkingInterruptedByReopen,
			EFFECT_OUTCOMES.setModelSuperseded,
			contextBudgetOutcome("the target cannot hold the fixed prefix"),
			EFFECT_OUTCOMES.dequeueInterruptedByReopen,
			unknownModelOutcome("faux", "missing"),
			providerUnavailableOutcome("no credentials"),
			unsupportedThinkingLevelOutcome("unsupported"),
		])
			expect(outcome.action).toContain("effectId");
		for (const outcome of [EFFECT_OUTCOMES.inputInterruptedByReopen, EFFECT_OUTCOMES.inputDroppedByReplace])
			expect(outcome.action).toContain("clientMessageId");
	});

	it("gives an aborted turn's reopen seal no action, since the turn it targeted is already gone", () => {
		expect(EFFECT_OUTCOMES.abortInterruptedByReopen).toMatchObject({ reason: "interrupted_by_reopen" });
		expect(EFFECT_OUTCOMES.abortInterruptedByReopen).not.toHaveProperty("action");
	});

	it("renders the two refusal errors with their code, reason and action", () => {
		const conflict = new EffectIdConflict("e1");
		const unreadable = new TranscriptUnreadable("~/missing.jsonl", new Error("ENOENT: no such file"));

		expect(conflict).toMatchObject({ code: "effect_id_conflict", effectId: "e1" });
		expect(conflict.reason.startsWith("effect_id_conflict")).toBe(true);
		expect(conflict.action).toContain("effectId");
		expect(unreadable).toMatchObject({ code: "transcript_unreadable", path: "~/missing.jsonl" });
		expect(unreadable.reason).toContain("ENOENT");
		expect(unreadable.action.trim().length).toBeGreaterThan(0);
	});
});
