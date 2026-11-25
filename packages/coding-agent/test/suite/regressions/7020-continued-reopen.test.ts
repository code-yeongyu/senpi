/**
 * senpi#7020: a session a host reopens because it was LIVE when the previous host ended (`session_start` with
 * `continued`) picks up where it was. A run the restart cut short continues once when the engine started it, never
 * when a person did (that person decides) and never when it was itself such a continuation (a crash loop stops at
 * one). A goal keeps continuing even after a long streak of continuations, which a cold reopen suppresses.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/session-control-types.ts";
import { STOP_RESUME_CUSTOM_TYPE } from "../../../src/core/stop-resume-directive.ts";
import { createHarness, type Harness } from "../harness.ts";
import {
	answer,
	asStart,
	cleanupKilledMidRun,
	continuedStart,
	engineStarted,
	killedMidRun,
	reopenContinued,
} from "./7020-killed-mid-run-support.ts";
import { firstTurnSettled, within } from "./7020-live-park-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
	cleanupKilledMidRun();
});

const TURN_MS = 10_000;

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

// senpi#7079: a continuation the next restart cuts continues again when it made progress, and a crash loop stops.
const restartContinued = (saved: SessionManager): void => {
	saved.appendCustomMessageEntry(STOP_RESUME_CUSTOM_TYPE, "resumed", false, { resumeCause: "interrupted" });
};
const progressed = (saved: SessionManager): void => {
	saved.appendMessage(answer("one step done"));
};
const peerDelivered = (saved: SessionManager): void => {
	saved.appendCustomMessageEntry(SESSION_CONTROL_DELIVERY_TYPE, "[from lead] keep going", true, {
		delivery_id: "lead-2",
		source: "session_control",
		deliverAs: "followUp",
	});
};
const holdsOf = (h: Harness) => h.session.holds.map(({ key, data }) => ({ key, data }));

async function expectHeld(run: (saved: SessionManager) => void, data: unknown, cutTool?: boolean): Promise<void> {
	const { base, file } = await killedMidRun(run, { cutTool });
	const { h } = await reopenContinued(base, file);
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(0);
	expect(holdsOf(h)).toEqual([{ key: "interrupted-run", data }]);
}

async function expectContinued(run: (saved: SessionManager) => void): Promise<void> {
	const { base, file } = await killedMidRun(run);
	const { h, turn } = await reopenContinued(base, file);
	await within(turn, TURN_MS, "the continued run's turn");
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.holds).toEqual([]);
}

it("continues again a continuation the next restart cut after it made progress", async () => {
	await expectContinued((saved) => {
		engineStarted(saved);
		restartContinued(saved);
		progressed(saved);
	});
});

it("holds a continuation the next restart cut before any progress, naming the repeated restart", async () => {
	await expectHeld(
		(saved) => {
			engineStarted(saved);
			restartContinued(saved);
		},
		{ reason: "repeated_restart_no_progress" },
		false,
	);
});

it("holds after three continuations without new input, and a peer delivery resets the count", async () => {
	const continuedThrice = (saved: SessionManager): void => {
		engineStarted(saved);
		for (let i = 0; i < 3; i++) {
			restartContinued(saved);
			progressed(saved);
		}
	};
	await expectHeld(continuedThrice, { reason: "repeated_restart_limit" });
	await expectContinued((saved) => {
		engineStarted(saved);
		restartContinued(saved);
		progressed(saved);
		restartContinued(saved);
		progressed(saved);
		peerDelivered(saved);
		restartContinued(saved);
		progressed(saved);
	});
});

it("keeps a continuation of a person-started run held for that person, whatever its progress", async () => {
	await expectHeld((saved) => {
		restartContinued(saved);
		progressed(saved);
	}, undefined);
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
	const continuations = () =>
		b.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "goal-continuation").length;
	const streak = continuations();
	const turn = firstTurnSettled(b.session);
	await b.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await within(turn, TURN_MS, "the goal's continuation");
	expect(b.faux.state.callCount - before).toBeGreaterThanOrEqual(1);
	expect(streak).toBeGreaterThanOrEqual(8);
	expect(continuations()).toBeGreaterThan(streak);
});
