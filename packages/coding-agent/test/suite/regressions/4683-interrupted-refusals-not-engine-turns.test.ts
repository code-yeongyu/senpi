import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { ENGINE_PAUSED_ENTRY_TYPE } from "../../../src/core/engine-paused.ts";
import { ENGINE_TURN_LIMIT_ENTRY_TYPE, ENGINE_TURN_START_ENTRY_TYPE } from "../../../src/core/engine-turn-limit.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import type { LifecycleSessionBinding } from "../../../src/core/lifecycle-session-binding.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// senpi#4683: while the previous run is interrupted, automatic deliveries must wait for Resume instead of
// being refused as turns, counted as engine-turn starts, and tripping the no-work pause.
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const TOOL_FREE_LIMIT = 12;
const SENDS = TOOL_FREE_LIMIT + 3;

function interruptedSession(): SessionManager {
	const sessionManager = SessionManager.inMemory();
	const sessionId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry("session-lifecycle", {
		sessionId,
		state: "running",
		seq: 2,
		epoch: 1,
		epochOrigin: "human",
		humanInputRevision: 1,
		selfSettleEligible: true,
		runPaused: false,
		since: "2026-10-28T00:00:00.000Z",
		role: "root",
		rootSessionId: sessionId,
		persisted: true,
		runActive: true,
		epochSealed: false,
		runId: "run-1",
	});
	return sessionManager;
}

async function harness(sessionManager?: SessionManager): Promise<{ h: Harness; pi: () => ExtensionAPI }> {
	let api: ExtensionAPI | undefined;
	const h = await createHarness({
		...(sessionManager === undefined ? {} : { sessionManager }),
		settings: { engineTurns: { maxPerUserInput: 0, maxToolFreePerMinute: TOOL_FREE_LIMIT } },
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	cleanups.push(h.cleanup);
	return {
		h,
		pi: () => {
			if (api === undefined) throw new Error("extension API not captured");
			return api;
		},
	};
}

function lifecycleBinding(h: Harness): LifecycleSessionBinding {
	return (h.session as unknown as { _lifecycleBinding: LifecycleSessionBinding })._lifecycleBinding;
}

function customEntries(h: Harness, customType: string): unknown[] {
	return h.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom" && entry.customType === customType ? [entry.data] : []));
}

function noticeIds(h: Harness): string[] {
	return customEntries(h, "session-notice").flatMap((data) => {
		const notice = data as { noticeId?: string; notices?: Array<{ noticeId: string }> };
		return notice.notices?.map((item) => item.noticeId) ?? (notice.noticeId === undefined ? [] : [notice.noticeId]);
	});
}

function consumedNoticeIds(h: Harness): string[] {
	return customEntries(h, "session-notices-consumed").flatMap((data) => (data as { noticeIds: string[] }).noticeIds);
}

function transcriptText(h: Harness): string {
	return h.session.messages.map((message) => getMessageText(message)).join("\n");
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function outcome(send: Promise<unknown>): Promise<string> {
	return send.then(
		() => "accepted",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

function sendMonitorEvent(h: Harness, index: number): Promise<string> {
	return outcome(
		h.session.sendCustomMessage(
			{ customType: "senpi-monitor:event", content: `monitor event ${index}`, display: false },
			{ triggerTurn: true },
		),
	);
}

function sendTaskCompletion(pi: ExtensionAPI, index: number): Promise<string> {
	return outcome(
		Promise.resolve(
			pi.sendMessage(
				{ customType: "senpi-task:completed", content: "task completions", display: false },
				{
					triggerTurn: true,
					items: [{ itemId: `task-${index}`, producer: "senpi-task", content: `task ${index} completed` }],
				},
			),
		),
	);
}

function expectNoEngineTurnRecords(h: Harness): void {
	expect(customEntries(h, ENGINE_TURN_START_ENTRY_TYPE)).toEqual([]);
	expect(customEntries(h, ENGINE_TURN_LIMIT_ENTRY_TYPE)).toEqual([]);
	expect(customEntries(h, ENGINE_PAUSED_ENTRY_TYPE)).toEqual([]);
}

function expectHeldForInterruptedRun(h: Harness, held: number): void {
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(h.session.holds.map((hold) => hold.key)).toEqual(["interrupted-run"]);
	expect(h.session.pausedNoticeCount).toBe(held);
	expect(noticeIds(h)).toHaveLength(held);
}

async function resumeOnce(h: Harness): Promise<void> {
	h.setResponses([fauxAssistantMessage("Resumed")]);
	await h.session.resumeSession();
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.paused).toBe(false);
	expect(h.session.pausedNoticeCount).toBe(0);
	expect(consumedNoticeIds(h).toSorted()).toEqual(noticeIds(h).toSorted());
	expect(customEntries(h, ENGINE_TURN_START_ENTRY_TYPE)).toEqual([]);
}

it("holds task completions and monitor events refused after the run was flagged interrupted, and delivers them on Resume", async () => {
	// Given a bound session whose run is flagged interrupted after it opened (the state senpi#4435 leaves).
	const { h, pi } = await harness();
	await h.session.bindExtensions({ mode: "tui" });
	expect(h.session.paused).toBe(false);
	lifecycleBinding(h).controller.ledger.interrupted = true;
	expect(lifecycleBinding(h).controller.requiresHumanContinuation).toBe(true);

	// When more automatic deliveries than the no-work limit arrive: itemized task completions and plain monitor events.
	const outcomes: string[] = [];
	for (let index = 1; index <= SENDS; index++)
		outcomes.push(await (index % 2 === 1 ? sendTaskCompletion(pi(), index) : sendMonitorEvent(h, index)));

	// Then none is refused, starts a turn, or counts as an engine turn, and the interrupted run holds every one.
	expect(outcomes).toEqual(Array.from({ length: SENDS }, () => "accepted"));
	expectNoEngineTurnRecords(h);
	expectHeldForInterruptedRun(h, SENDS);

	// When the user resumes.
	await resumeOnce(h);

	// Then every task completion reaches the one resumed turn once and in order, and the monitor events arrive once
	// as their source's latest event with its count (the held-notice contract, senpi#3811).
	const text = transcriptText(h);
	const tasks = Array.from({ length: (SENDS + 1) / 2 }, (_, index) => `task ${index * 2 + 1} completed`);
	for (const task of tasks) expect(occurrences(text, task)).toBe(1);
	expect(tasks.map((task) => text.indexOf(task))).toEqual(
		tasks.map((task) => text.indexOf(task)).toSorted((a, b) => a - b),
	);
	expect(
		occurrences(text, `${(SENDS - 1) / 2} automatic monitor wakes held. Latest event:\nmonitor event ${SENDS - 1}`),
	).toBe(1);
});

it("holds automatic deliveries for a reopened interrupted session that no host has bound, and delivers them on Resume", async () => {
	// Given a reopened session whose previous run was interrupted, driven without extension binding.
	const { h } = await harness(interruptedSession());
	expect(lifecycleBinding(h).controller.requiresHumanContinuation).toBe(true);

	// When more automatic monitor events than the no-work limit arrive.
	const outcomes: string[] = [];
	for (let index = 1; index <= SENDS; index++) outcomes.push(await sendMonitorEvent(h, index));

	// Then none is refused or counted, and the interrupted run holds them.
	expect(outcomes).toEqual(Array.from({ length: SENDS }, () => "accepted"));
	expectNoEngineTurnRecords(h);
	expectHeldForInterruptedRun(h, SENDS);

	// When the user resumes, then every held notice is consumed by one turn that carries the latest event once.
	await resumeOnce(h);
	expect(
		occurrences(transcriptText(h), `${SENDS} automatic monitor wakes held. Latest event:\nmonitor event ${SENDS}`),
	).toBe(1);
});

it("still counts automatic turns that really start and pauses them for no work", async () => {
	// Given a session whose previous run was not interrupted.
	const { h } = await harness();
	await h.session.bindExtensions({ mode: "tui" });
	expect(lifecycleBinding(h).controller.requiresHumanContinuation).toBe(false);
	h.setResponses(Array.from({ length: SENDS }, () => fauxAssistantMessage("Nothing to do")));

	// When more tool-free automatic turns than the limit are requested.
	const outcomes: string[] = [];
	for (let index = 1; index <= SENDS; index++) outcomes.push(await sendMonitorEvent(h, index));

	// Then each started turn counts, and the turn past the limit is paused for doing no work.
	expect(outcomes).toEqual(Array.from({ length: SENDS }, () => "accepted"));
	expect(h.faux.state.callCount).toBe(TOOL_FREE_LIMIT);
	expect(customEntries(h, ENGINE_TURN_START_ENTRY_TYPE)).toHaveLength(TOOL_FREE_LIMIT);
	expect(customEntries(h, ENGINE_PAUSED_ENTRY_TYPE)).toEqual([
		expect.objectContaining({ reason: "cap-per-minute", count: TOOL_FREE_LIMIT }),
	]);
	expect(h.session.holds).toEqual([]);
});
