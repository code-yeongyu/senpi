import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { EngineTurnHold } from "../../../src/core/engine-turn-hold.ts";
import { EngineTurnRelease } from "../../../src/core/engine-turn-release.ts";
import type { Harness } from "../harness.ts";
import { heldHarness, wake } from "./3853-review-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});
const copies = (h: Harness) => h.session.messages.filter((m) => m.role === "custom" && m.content === wake.content);

// senpi#3853, review A: admission must persist consumption before another release can race it.
it.each(["input+resume", "input+replay", "resume+replay", "resume+resume"])(
	"delivers each held entry once across %s",
	async (pair) => {
		const { h, entered, release } = await heldHarness();
		harnesses.push(h);
		await h.session.sendCustomMessage(wake, { triggerTurn: true });
		const first = pair.startsWith("input") ? h.session.prompt("continue") : h.session.resumeSession();
		await entered.promise;
		try {
			// Restart replay observes the same persisted ledger, not in-flight process memory.
			const replay = new EngineTurnHold(
				h.sessionManager.getEntries(),
				true,
				() => {},
				() => {},
				() => {},
			);
			const replayCount = replay.messages().length;
			replay.start();
			const second =
				pair === "input+resume" || pair === "resume+resume"
					? h.session.resumeSession()
					: new EngineTurnRelease().resume(
							replay,
							async (message) => {
								await h.session.sendCustomMessage(message, { triggerTurn: true });
								return true;
							},
							async () => {},
						);
			release.resolve();
			await Promise.all([first, second]);
			expect(replayCount).toBe(0);
			await h.session.prompt("next input");
			expect(copies(h)).toHaveLength(1);
			expect(h.faux.state.callCount).toBe(3);
			expect(h.session.paused).toBe(false);
		} finally {
			release.resolve();
			await first;
		}
	},
);

it("does not invalidate Resume consumption when a human steers during delivery", async () => {
	const { h, entered, release } = await heldHarness();
	harnesses.push(h);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	const first = h.session.resumeSession();
	await entered.promise;
	try {
		await h.session.steer("human steering");
	} finally {
		release.resolve();
		await first;
	}
	await h.session.prompt("next input");
	expect(copies(h)).toHaveLength(1);
	expect(h.session.paused).toBe(false);
	expect(h.session.pausedNoticeCount).toBe(0);
});

// Review F: Resume cannot hand a released entry to a queue while retaining it.
it("waits for an active turn before delivering a held Resume snapshot", async () => {
	const { h, entered, release } = await heldHarness();
	harnesses.push(h);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	const running = h.session.sendCustomMessage(
		{ customType: "manual-continue", content: "human-directed turn", display: false },
		{ triggerTurn: true },
	);
	await entered.promise;
	const resumed = h.session.resumeSession();
	release.resolve();
	await Promise.all([running, resumed]);
	await h.session.prompt("next input");
	expect(copies(h)).toHaveLength(1);
	expect(h.session.paused).toBe(false);
});

// Review H: source-only notices have no model payload, but must still be consumed.
it("releases a message-less extension notice without recreating its hold", async () => {
	const { h, release } = await heldHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => ctx.noteHeldWake?.("own-source"));
			},
		],
	});
	harnesses.push(h);
	release.resolve();
	await h.session.resumeSession();
	expect(h.session.paused).toBe(false);
	expect(h.session.pausedNoticeCount).toBe(0);
});

it("never delegates a held release into a pending compaction queue", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { h } = await heldHarness({
		settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async () => {
					entered.resolve();
					await release.promise;
					return { cancel: true, rejectionCause: "cancelled-by-extension" as const };
				});
			},
		],
	});
	harnesses.push(h);
	h.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText("done")])));
	await h.session.sendCustomMessage(
		{ ...wake, customType: "manual-continue", content: "seed" },
		{ triggerTurn: true },
	);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	const compacted = h.session.compact().catch(() => undefined);
	await entered.promise;
	const resumed = h.session.resumeSession();
	release.resolve();
	await Promise.all([compacted, resumed]);
	expect(h.agent.hasQueuedMessages()).toBe(false);
	await h.session.resumeSession();
	await h.session.prompt("next input");
	expect(copies(h)).toHaveLength(1);
});

it("retains custody without delivery when the persisted claim fails", async () => {
	const { h } = await heldHarness();
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage([fauxText("done")])]);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	const append = h.sessionManager.appendCustomEntry.bind(h.sessionManager);
	const failure = vi.spyOn(h.sessionManager, "appendCustomEntry").mockImplementation((type, data, options) => {
		if (type === "session-notices-consumed") throw new Error("claim write failed");
		return append(type, data, options);
	});
	try {
		await expect(h.session.resumeSession()).rejects.toThrow("claim write failed");
		expect(h.faux.state.callCount).toBe(0);
		expect(h.session.paused).toBe(true);
		expect(h.session.pausedNoticeCount).toBe(1);
	} finally {
		failure.mockRestore();
	}
	await h.session.resumeSession();
	expect(copies(h)).toHaveLength(1);
	expect(h.faux.state.callCount).toBe(1);
});
