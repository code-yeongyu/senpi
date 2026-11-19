/**
 * senpi#7020: a session a host reopens because it was LIVE when the previous host ended (`session_start` with
 * `continued`) picks up where it was. A run the restart cut short continues once when the engine started it, never
 * when a person did (that person decides) and never when it was itself such a continuation (a crash loop stops at
 * one). A goal keeps continuing even after a long streak of continuations, which a cold reopen suppresses.
 */
import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { SessionStartEvent } from "../../../src/core/extensions/types.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { STOP_RESUME_CUSTOM_TYPE } from "../../../src/core/stop-resume-directive.ts";
import { createHarness, type Harness } from "../harness.ts";
import { firstTurnSettled, within } from "./7020-live-park-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

const TURN_MS = 10_000;
/** What a host reopening a session that was live when its predecessor ended passes to `session_start`. */
const continuedStart = { type: "session_start", reason: "resume", continued: true } as const;
const asStart = (event: object): SessionStartEvent => event as SessionStartEvent;

function answer(text: string): AssistantMessage {
	return fauxAssistantMessage(text);
}

/** A session file as a SIGKILL left it: the opening lifecycle record says `runActive`, then `run` wrote its start. */
async function killedMidRun(run: (saved: SessionManager) => void): Promise<{ base: Harness; file: string }> {
	const base = await createHarness({ persistSession: true });
	harnesses.push(base);
	const saved = base.sessionManager;
	saved.appendMessage({ role: "user", content: "Original request", timestamp: 1 });
	saved.appendMessage(answer("Previous answer"));
	run(saved);
	saved.appendCustomEntry("session-lifecycle", {
		sessionId: saved.getSessionId(),
		state: "running",
		seq: 2,
		epoch: 1,
		epochOrigin: "automatic",
		humanInputRevision: 1,
		selfSettleEligible: true,
		runPaused: false,
		since: "2026-11-19T02:40:53.619Z",
		role: "root",
		rootSessionId: saved.getSessionId(),
		persisted: true,
		runActive: true,
		epochSealed: false,
		runId: "killed-run",
	});
	saved.appendMessage({
		...answer(""),
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "make deploy" } }],
		stopReason: "toolUse",
	});
	const file = saved.getSessionFile();
	if (!file) throw new Error("the killed session has no file");
	return { base, file };
}

async function reopenContinued(base: Harness, file: string): Promise<{ h: Harness; turn: Promise<void> }> {
	const h = await createHarness({
		siblingOf: base,
		sessionManager: SessionManager.open(file),
		sessionStartEvent: asStart(continuedStart),
	});
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage([fauxText("continued")])]);
	const turn = firstTurnSettled(h.session);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	return { h, turn };
}

const engineStarted = (saved: SessionManager): void => {
	saved.appendCustomEntry("engine-turn-start", { customType: "senpi-monitor:event" });
	saved.appendCustomMessageEntry("senpi-monitor:event", "build finished", false, {});
};

it("continues an engine-started run the restart cut, once, with no input", async () => {
	const { base, file } = await killedMidRun(engineStarted);
	const { h, turn } = await reopenContinued(base, file);
	await within(turn, TURN_MS, "the continued run's turn");
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.holds).toEqual([]);
	expect(h.session.paused).toBe(false);
});

it("keeps a person-started run that the restart cut held for that person", async () => {
	const { base, file } = await killedMidRun(() => {});
	const { h } = await reopenContinued(base, file);
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.holds.map((hold) => hold.key)).toEqual(["interrupted-run"]);
});

it("does not continue a run that was itself the continuation of a cut run", async () => {
	const { base, file } = await killedMidRun((saved) => {
		engineStarted(saved);
		saved.appendCustomMessageEntry(STOP_RESUME_CUSTOM_TYPE, "resumed", false, { resumeCause: "interrupted" });
	});
	const { h } = await reopenContinued(base, file);
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.holds.map((hold) => hold.key)).toEqual(["interrupted-run"]);
});

// C6: a cold reopen suppresses a goal that ends on 8 continuations; a session the restart interrupted is not cold.
it("keeps an active goal continuing past a streak of 8 continuations", async () => {
	const a = await createHarness({ persistSession: true, extensionFactories: [(pi) => goalExtension(pi)] });
	harnesses.push(a);
	await a.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	a.setResponses([
		fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Keep the docs current" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("Goal created; stopping here.")]),
	]);
	await a.session.prompt("set a goal and stop");
	for (let i = 0; i < 8; i++) {
		a.sessionManager.appendCustomMessageEntry("goal-continuation", `continue ${i}`, false, {});
		a.sessionManager.appendMessage(answer(`step ${i}`));
	}
	const file = a.sessionManager.getSessionFile();
	if (!file) throw new Error("the session was not persisted");
	a.session.dispose();

	const b = await createHarness({
		siblingOf: a,
		sessionManager: SessionManager.open(file),
		extensionFactories: [(pi) => goalExtension(pi)],
		sessionStartEvent: asStart(continuedStart),
	});
	harnesses.push(b);
	b.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage([fauxText("still working")])));
	const before = b.faux.state.callCount;
	const turn = firstTurnSettled(b.session);
	await b.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await within(turn, TURN_MS, "the goal's continuation");
	expect(b.faux.state.callCount - before).toBeGreaterThanOrEqual(1);
	expect(
		b.session.messages.filter((m) => m.role === "custom" && m.customType === "goal-continuation").length,
	).toBeGreaterThan(8);
});
