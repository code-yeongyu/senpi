/**
 * senpi#7138: a peer delivery that the engine-turn cap stops was answered `started`, made no provider call, and the
 * cap was invisible: `paused: false`, no hold, and `resume_session` answered `not_paused`. The admission answer, the
 * session state and Resume now name the cap; Resume continues a capped session with one turn that answers the parked
 * messages and ends the window. (The unattended-hold half of #7138 is #6490: a peer message releases that hold.)
 */
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/session-control-types.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/rpc-session-state.ts";
import { createHarness, type Harness } from "../harness.ts";
import { appendHistoricalEngineStarts } from "./7020-live-park-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

const wake = { customType: "senpi-monitor:event", content: "continue", display: false };

/** Admits a peer delivery and waits until its entry is written and the session is idle again. */
async function admitAndSettle(h: Harness, deliveryId: string, text: string) {
	const emitted = new Promise<void>((resolve) => {
		const stop = h.session.externalAdmission.onEmitted((id) => {
			if (id !== deliveryId) return;
			stop();
			resolve();
		});
	});
	const answer = h.session.externalAdmission.admit({ delivery_id: deliveryId, text, deliverAs: "followUp" });
	await emitted;
	await h.session.waitForIdle();
	return answer;
}

/** A session reopened unattended, released by Resume, whose resume window (8 engine turns) is used up. */
async function resumeWindowSpent(): Promise<Harness> {
	const h = await createHarness({
		persistSession: true,
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		settings: { engineTurns: { maxToolFreePerMinute: 0 } },
	});
	harnesses.push(h);
	h.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage([fauxText("done")])));
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await h.session.resumeSession();
	for (let i = 0; i < 8; i++) await h.session.sendCustomMessage(wake, { triggerTurn: true });
	expect(h.faux.state.callCount).toBe(8);
	expect(h.session.holds).toEqual([]);
	return h;
}

function deliveryIndex(h: Harness, text: string): number {
	return h.session.messages.findIndex(
		(message) =>
			message.role === "custom" && message.customType === SESSION_CONTROL_DELIVERY_TYPE && message.content === text,
	);
}

it("a peer delivery behind the resume-window cap is answered held with the cap, not started, and makes no provider call", async () => {
	const h = await resumeWindowSpent();
	const answer = await admitAndSettle(h, "cap-1", "[from lead] next step");
	expect(h.faux.state.callCount).toBe(8);
	expect(answer).toMatchObject({ kind: "held", engine_turn_cap: { reason: "cap-per-resume-window", count: 8 } });
	expect(answer.holds).toBeUndefined();

	const state = buildRpcSessionState(h.session);
	expect(state.engineTurnCap).toEqual({ reason: "cap-per-resume-window", count: 8 });
	expect(state.holds).toEqual([]);
});

it("Resume continues a session the cap stopped: one turn carries the parked delivery and ends the window", async () => {
	const h = await resumeWindowSpent();
	await admitAndSettle(h, "cap-2", "[from lead] parked");
	expect(h.faux.state.callCount).toBe(8);

	const answer = await h.session.resumeSessionRequest({});
	await h.session.waitForIdle();
	expect(answer).toMatchObject({
		resumed: true,
		turnStarted: true,
		engineTurnCap: { reason: "cap-per-resume-window", count: 8 },
	});
	expect(h.faux.state.callCount).toBe(9);
	// The parked delivery is in the context of the turn Resume started, ahead of that turn's reply.
	const parked = deliveryIndex(h, "[from lead] parked");
	expect(parked).toBeGreaterThanOrEqual(0);
	expect(h.session.messages.slice(parked + 1).some((message) => message.role === "assistant")).toBe(true);
	expect(buildRpcSessionState(h.session).engineTurnCap).toBeUndefined();

	expect(await admitAndSettle(h, "cap-3", "[from lead] after resume")).toMatchObject({ kind: "started" });
	expect(h.faux.state.callCount).toBe(10);
});

it("Resume in release mode names the cap instead of answering not_paused, and starts nothing", async () => {
	const h = await resumeWindowSpent();
	const answer = await h.session.resumeSessionRequest({ mode: "release" });
	expect(answer).toMatchObject({
		resumed: false,
		reason: "engine_turn_cap",
		engineTurnCap: { reason: "cap-per-resume-window", count: 8 },
	});
	expect(h.faux.state.callCount).toBe(8);
});

it("a peer delivery that releases an unattended hold but meets an explicit per-message cap is answered held with the cap", async () => {
	const h = await createHarness({
		persistSession: true,
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		settings: { engineTurns: { maxPerUserInput: 3, maxToolFreePerMinute: 0 } },
	});
	harnesses.push(h);
	h.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage([fauxText("done")])));
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	appendHistoricalEngineStarts(h, 3);
	expect(h.session.holds.map((hold) => hold.kind)).toEqual(["unattended"]);

	const answer = await admitAndSettle(h, "msg-cap-1", "[from lead] go on");
	expect(h.faux.state.callCount).toBe(0);
	expect(answer).toMatchObject({ kind: "held", engine_turn_cap: { reason: "cap-per-message", count: 3 } });
});
