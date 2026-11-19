import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const RUN = "killed-run";

function answer(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { ...fauxAssistantMessage(text), stopReason };
}

function toolCallAnswer(): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "make deploy" } }],
		stopReason: "toolUse",
	};
}

/**
 * A session file as its process left it when killed with no shutdown write (SIGKILL): the run's opening lifecycle
 * record says `runActive`, then `afterOpen` writes what the run got to before the kill.
 */
async function killedSessionFile(afterOpen: (saved: SessionManager) => void): Promise<{ base: Harness; file: string }> {
	const base = await createHarness({ persistSession: true });
	cleanups.push(base.cleanup);
	const saved = base.sessionManager;
	saved.appendMessage({ role: "user", content: "Original request", timestamp: 1 });
	saved.appendMessage(answer("Previous answer"));
	saved.appendCustomEntry("session-lifecycle", {
		sessionId: saved.getSessionId(),
		state: "running",
		seq: 2,
		epoch: 1,
		epochOrigin: "human",
		humanInputRevision: 1,
		selfSettleEligible: true,
		runPaused: false,
		since: "2026-11-19T02:40:53.619Z",
		role: "root",
		rootSessionId: saved.getSessionId(),
		persisted: true,
		runActive: true,
		epochSealed: false,
		runId: RUN,
	});
	afterOpen(saved);
	const file = saved.getSessionFile();
	if (!file) throw new Error("The killed session has no file");
	return { base, file };
}

/** Reopens the file on a daemon the way `thread_create({ thread })` does: an unattended RPC session. */
async function reopened(afterOpen: (saved: SessionManager) => void): Promise<Harness> {
	const { base, file } = await killedSessionFile(afterOpen);
	const h = await createHarness({
		siblingOf: base,
		sessionManager: SessionManager.open(file),
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	cleanups.push(h.cleanup);
	h.setResponses([fauxAssistantMessage([fauxText("continued")])]);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	return h;
}

function idleOrHeld(h: Harness): Promise<"idle" | "held"> {
	return new Promise((resolve) => {
		const unsubscribe = h.session.subscribe((event) => {
			const outcome =
				event.type === "agent_idle"
					? "idle"
					: event.type === "session_notice" && event.disposition === "notice_persisted"
						? "held"
						: undefined;
			if (outcome === undefined) return;
			unsubscribe();
			resolve(outcome);
		});
	});
}

const ended: Array<[string, (saved: SessionManager) => void]> = [
	["its answer was written", (saved) => saved.appendMessage(answer("Done for now"))],
	[
		// The reported file: a peer delivery started the run and the TUI's exit aborted its model request.
		"a peer delivery's request was aborted with nothing run",
		(saved) => {
			saved.appendCustomMessageEntry(SESSION_CONTROL_DELIVERY_TYPE, "[from lead] ready to move?", true, {});
			saved.appendMessage(answer("", "aborted"));
		},
	],
	[
		"the monitor delivery it consumed was answered",
		(saved) => {
			const entryId = saved.appendCustomMessageEntry("senpi-monitor:event", "build finished", false, {
				ticketId: "monitor-ticket",
			});
			saved.appendCustomEntry("work-custody", {
				sessionId: saved.getSessionId(),
				id: "monitor-delivery",
				key: "delivery:senpi-monitor:event:1",
				kind: "background",
				state: "consumed",
				ticketId: "monitor-ticket",
				runId: RUN,
				transcriptEntryId: entryId,
			});
			saved.appendMessage(answer("Build looks good"));
		},
	],
];

// senpi#7016: a lane that had gone idle was killed for a move and reopened by id. The file still recorded its last run
// as active (the idle record had not landed), so it reopened under the interrupted-run hold and held every delivery.
it.each(ended)("a session killed after its run ended (%s) reopens without the interrupted-run hold", async (_, run) => {
	const h = await reopened(run);
	expect(h.session.holds.map((hold) => hold.key)).not.toContain("interrupted-run");
	expect(h.session.lifecycle.waitingOn?.human?.some((wait) => wait.kind === "interrupted_run")).not.toBe(true);

	const outcome = idleOrHeld(h);
	expect(
		h.session.externalAdmission.admit({ delivery_id: "move-1", text: "[from lead] continue", deliverAs: "followUp" }),
	).toMatchObject({ kind: "started" });
	expect(await outcome).toBe("idle");
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.paused).toBe(false);
});

const inFlight: Array<[string, (saved: SessionManager) => void]> = [
	["its model request was in flight", () => {}],
	["a tool call had no result", (saved) => saved.appendMessage(toolCallAnswer())],
	[
		"its tool had returned and the next request was in flight",
		(saved) => {
			saved.appendMessage(toolCallAnswer());
			saved.appendMessage({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "deployed" }],
				isError: false,
				timestamp: 2,
			});
		},
	],
];

it.each(inFlight)("a session killed while %s still reopens interrupted, and a peer is told held", async (_, run) => {
	const h = await reopened(run);
	expect(h.session.holds.map((hold) => hold.key)).toContain("interrupted-run");
	const outcome = idleOrHeld(h);
	expect(
		h.session.externalAdmission.admit({ delivery_id: "move-2", text: "[from lead] continue", deliverAs: "followUp" }),
	).toMatchObject({ kind: "held" });
	expect(await outcome).toBe("held");
	expect(h.faux.state.callCount).toBe(0);
});

/** The interrupted session reopened behind a real RPC connection, the transport the thread tools' host uses. */
async function interruptedOverRpc() {
	const { base, file } = await killedSessionFile((saved) => saved.appendMessage(toolCallAnswer()));
	const fixture = await createIdentityHarness({
		siblingOf: base,
		sessionManager: SessionManager.open(file),
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	cleanups.push(fixture.cleanup);
	const rpc = fixture.bind();
	await rpc.handler.ready;
	expect(fixture.session.holds.map((hold) => hold.key)).toContain("interrupted-run");
	return { fixture, rpc };
}

it("a remote resume_session with unlessStopped continues an interrupted run", async () => {
	const { fixture, rpc } = await interruptedOverRpc();
	fixture.harness.setResponses([fauxAssistantMessage("Recovered")]);
	const response = await rpc.send({
		type: "resume_session",
		expectedSeq: fixture.session.pauseView.pauseSeq,
		unlessStopped: true,
	});
	await fixture.session.resumeSettled();
	expect(response).toMatchObject({ success: true, data: { resumed: true, turnStarted: true } });
	expect(fixture.harness.faux.state.callCount).toBe(1);
	expect(fixture.session.paused).toBe(false);
	expect(fixture.session.holds).toEqual([]);
});

it("a remote resume_session with unlessStopped never releases a person's Stop", async () => {
	const { fixture, rpc } = await interruptedOverRpc();
	await fixture.session.stop();
	const refused = await rpc.send({ type: "resume_session", unlessStopped: true });
	expect(refused).toMatchObject({ success: true, data: { resumed: false, reason: "stopped", turnStarted: false } });
	expect(fixture.harness.faux.state.callCount).toBe(0);
	expect(fixture.session.paused).toBe(true);
	expect(fixture.session.holds.map((hold) => hold.kind)).toContain("session_hold");
	expect(fixture.session.holds.some((hold) => hold.key !== "interrupted-run")).toBe(true);
});
