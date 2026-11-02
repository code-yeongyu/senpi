import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { ENGINE_TURN_START_ENTRY_TYPE } from "../../../src/core/engine-turn-limit.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, getMessageText } from "../harness.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// #4692: force interruption after the first wake gate, while admission awaits an actual extension handler.
// Unlike #4683's pre-flagged cases, itemized sends must retire their original ticket and re-admit into notices.
it.each([false, true])("holds an interruption discovered during admission (itemized: %s)", async (itemized) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let api: ExtensionAPI | undefined;
	let beforeStarts = 0;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				api = pi;
				pi.on("before_agent_start", async () => {
					beforeStarts++;
					if (beforeStarts !== 1) return;
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	cleanups.push(h.cleanup);
	await h.session.bindExtensions({ mode: "rpc" });
	if (!api) throw new Error("Extension API was not bound");
	const message = { customType: "senpi-task:completed", content: "Completed task payload", display: false };
	const send = itemized
		? Promise.resolve(
				api.sendMessage(message, {
					triggerTurn: true,
					items: [{ itemId: "one-task", producer: "senpi-task", content: "Completed task payload" }],
				}),
			)
		: h.session.sendCustomMessage(message, { triggerTurn: true });
	await entered.promise;
	h.session["_lifecycleBinding"].controller.ledger.interrupted = true;
	release.resolve();
	const receipt = await send;
	if (itemized)
		expect(receipt).toEqual([expect.objectContaining({ itemId: "one-task", disposition: "notice_persisted" })]);
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.holds.map((hold) => hold.key)).toEqual(["interrupted-run"]);
	expect(h.session.pausedNoticeCount).toBe(1);
	expect(
		h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === ENGINE_TURN_START_ENTRY_TYPE),
	).toEqual([]);

	h.setResponses([fauxAssistantMessage("Resumed")]);
	await h.session.resumeSession();
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.messages.filter((entry) => getMessageText(entry).includes("Completed task payload"))).toHaveLength(
		1,
	);
	expect(h.session.pausedNoticeCount).toBe(0);
	expect(h.session.workObligations.active).toEqual([]);
	// The handler already running at interruption cannot be undone; Resume invokes it for the real turn.
	expect(beforeStarts).toBe(2);
});
