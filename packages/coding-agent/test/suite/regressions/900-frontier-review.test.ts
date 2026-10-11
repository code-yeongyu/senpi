import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTotalTokens } from "../../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	appendReduction,
	createReductionHarness,
	reductionBytes,
	reductionSeed,
	renderReduction,
	resultPair,
	savedReduction,
	textAssistant,
} from "../../support/context-reduction-fixture.ts";
import type { Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});
async function setup(options: Parameters<typeof createReductionHarness>[0] = {}) {
	const result = await createReductionHarness(options);
	harnesses.push(result.h);
	return result;
}

describe("frontier review regressions", () => {
	it("persists and reuses the frontier through real agent requests", async () => {
		const manager = SessionManager.inMemory();
		for (const message of reductionSeed()) manager.appendMessage(message);
		const { h } = await setup({ sessionManager: manager });
		h.agent.state.messages = manager.buildSessionContext().messages;
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await h.session.prompt("Continue.");
		const first = savedReduction(h);
		expect(first.engaged).toBe(true);
		expect(first.cutIndex).toBeGreaterThan(0);
		await h.session.prompt("Continue again.");
		const requests = h.faux.getCallLog().map((call) => call.context.messages);
		expect(requests).toHaveLength(2);
		expect(savedReduction(h).cutIndex).toBe(first.cutIndex);
		expect(savedReduction(h).prefixHash).toBe(first.prefixHash);
		const [before, after] = requests;
		if (!before || !after) throw new Error("Missing real request");
		expect(reductionBytes(after.slice(0, before.length))).toBe(reductionBytes(before));
	});

	it("bounds near-ceiling steps over sixty turns and never sends a rewritten prefix after handoff", async () => {
		const { h, compactions, aborts } = await setup({ maxTokens: 40_000 });
		appendReduction(h, reductionSeed());
		let previous = await renderReduction(h);
		let state = savedReduction(h);
		let steps = 1;
		let stable = 0;
		for (let turn = 0; turn < 60; turn++) {
			appendReduction(h, [
				textAssistant(100 + turn, 900),
				{ role: "user", content: "followup ".repeat(400), timestamp: 200 + turn },
			]);
			const beforeAborts = aborts.mock.calls.length;
			const outgoing = await renderReduction(h);
			const next = savedReduction(h);
			if (next.cutIndex !== state.cutIndex || next.prefixHash !== state.prefixHash) steps++;
			else if (aborts.mock.calls.length === beforeAborts) {
				expect(reductionBytes(outgoing.slice(0, previous.length))).toBe(reductionBytes(previous));
				stable++;
			}
			expect(estimateTotalTokens(outgoing)).toBeLessThan(60_000);
			state = next;
			previous = outgoing;
		}
		expect(stable).toBeGreaterThan(0);
		expect(steps).toBeLessThanOrEqual(3);
		expect(compactions).toHaveBeenCalledTimes(1);
		expect(aborts).toHaveBeenCalled();
	});

	it("keeps foreign summary and cache-friendly contexts out of the saved frontier", async () => {
		const { h, compactions } = await setup();
		appendReduction(h, reductionSeed());
		const runner = h.getExtensionRunner();
		await runner.prepareProviderRequest(h.sessionManager.buildSessionContext().messages);
		expect(savedReduction(h).engaged).toBe(false);
		await renderReduction(h);
		appendReduction(h, resultPair(100, "eval", 300));
		const before = await renderReduction(h);
		const saved = savedReduction(h);
		const live = h.sessionManager.buildSessionContext().messages;
		await runner.prepareProviderRequest([
			{ role: "user", content: "Summary source", timestamp: 200 },
			...live.slice(0, 20),
		]);
		expect(savedReduction(h)).toEqual(saved);
		await runner.prepareProviderRequest([
			{ role: "user", content: "cache-friendly summary instruction", timestamp: 201 },
			...live,
		]);
		expect(savedReduction(h)).toEqual(saved);
		appendReduction(h, resultPair(101, "eval", 300));
		expect(reductionBytes((await renderReduction(h)).slice(0, before.length))).toBe(reductionBytes(before));
		expect(compactions).not.toHaveBeenCalled();
	});

	it("requests compaction when an emergency prune alone keeps the prompt legal", async () => {
		const { h, compactions, aborts } = await setup();
		appendReduction(h, reductionSeed());
		await renderReduction(h);
		appendReduction(h, resultPair(100, "eval", 60_000));
		const outgoing = await renderReduction(h);
		expect(estimateTotalTokens(outgoing)).toBeLessThan(96_000);
		expect(compactions).toHaveBeenCalledTimes(1);
		expect(aborts).toHaveBeenCalled();
	});

	it("persists the actual request usage anchor and restores its conservative bound", async () => {
		const { h } = await setup();
		appendReduction(h, reductionSeed());
		const count = h.sessionManager.buildSessionContext().messages.length;
		await renderReduction(h);
		const cut = savedReduction(h);
		const response = textAssistant(400, 100);
		response.usage.input = 72_000;
		response.usage.totalTokens = 72_000;
		appendReduction(h, [response]);
		await h.getExtensionRunner().emitMessageEnd({ type: "message_end", message: response });
		expect(savedReduction(h)).toMatchObject({
			anchorCount: count,
			anchorCut: cut.cutIndex,
			anchorHash: cut.prefixHash,
			anchorTokens: 72_000,
		});
		const file = h.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const { h: resumed, compactions } = await setup({ sessionManager: SessionManager.open(file), siblingOf: h });
		await renderReduction(resumed);
		expect(compactions).toHaveBeenCalledTimes(1);
	});

	it.each(["accepted", "rejected", "queued", "moved"])(
		"requests continuation only for an accepted current handoff: %s",
		async (outcome) => {
			const { h, compactions, continuations, queued } = await setup();
			appendReduction(h, reductionSeed());
			await renderReduction(h);
			const savedLeaf = h.sessionManager.getLeafId();
			if (!savedLeaf) throw new Error("Missing saved branch");
			appendReduction(h, resultPair(100, "eval", 60_000));
			await renderReduction(h);
			expect(continuations).not.toHaveBeenCalled();
			const options = compactions.mock.calls[0]?.[0];
			if (!options) throw new Error("Missing compaction handoff");
			if (outcome === "rejected") {
				options?.onError?.(new Error("rejected"));
				expect(continuations).not.toHaveBeenCalled();
				return;
			}
			if (outcome === "queued") queued.mockReturnValue(true);
			if (outcome === "moved") {
				const oldLeafId = h.sessionManager.getLeafId();
				h.sessionManager.branch(savedLeaf);
				await h.getExtensionRunner().emit({ type: "session_tree", oldLeafId, newLeafId: savedLeaf });
			}
			options.onComplete?.({ summary: "summary", firstKeptEntryId: "kept", tokensBefore: 100_000 });
			if (outcome !== "accepted") {
				expect(continuations).not.toHaveBeenCalled();
				return;
			}
			expect(continuations).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "senpi.context-reduction.resume", display: false }),
				expect.objectContaining({ triggerTurn: true }),
			);
		},
	);

	it("allows a fresh handoff after failure rather than persisting an orphaned request", async () => {
		const { h, compactions, continuations } = await setup();
		appendReduction(h, reductionSeed());
		await renderReduction(h);
		appendReduction(h, resultPair(100, "eval", 60_000));
		await renderReduction(h);
		expect(compactions).toHaveBeenCalledTimes(1);
		compactions.mock.calls[0]?.[0]?.onError?.(new Error("failed"));
		await renderReduction(h);
		expect(compactions).toHaveBeenCalledTimes(2);
		expect(continuations).not.toHaveBeenCalled();
		for (const entry of h.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "senpi.context-reduction.v1") continue;
			expect(entry.data).not.toHaveProperty("compactionRequested");
			expect(entry.data).not.toHaveProperty("compactionRequired");
		}
	});

	it.each(["tree", "fork"])("restores a matching saved frontier after %s navigation", async (navigation) => {
		const { h } = await setup();
		appendReduction(h, reductionSeed());
		await renderReduction(h);
		for (let index = 0; index < 6; index++) appendReduction(h, resultPair(100 + index, "read", 300));
		const expected = await renderReduction(h);
		const saved = savedReduction(h);
		const leaf = h.sessionManager.getLeafId();
		if (!leaf) throw new Error("Expected branch leaf");
		if (navigation === "tree") {
			h.sessionManager.resetLeaf();
			appendReduction(h, [{ role: "user", content: "Other branch", timestamp: 300 }]);
			await h
				.getExtensionRunner()
				.emit({ type: "session_tree", oldLeafId: leaf, newLeafId: h.sessionManager.getLeafId() });
			await renderReduction(h);
			const other = h.sessionManager.getLeafId();
			h.sessionManager.branch(leaf);
			await h.getExtensionRunner().emit({ type: "session_tree", oldLeafId: other, newLeafId: leaf });
			expect(reductionBytes(await renderReduction(h))).toBe(reductionBytes(expected));
			expect(savedReduction(h).cutIndex).toBe(saved.cutIndex);
			return;
		}
		const forkFile = h.sessionManager.createBranchedSession(leaf);
		if (!forkFile) throw new Error("Expected persisted fork");
		const { h: fork } = await setup({ sessionManager: SessionManager.open(forkFile), siblingOf: h });
		await fork.getExtensionRunner().emit({ type: "session_start", reason: "fork" });
		expect(reductionBytes(await renderReduction(fork))).toBe(reductionBytes(expected));
		expect(savedReduction(fork).cutIndex).toBe(saved.cutIndex);
	});
});

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
