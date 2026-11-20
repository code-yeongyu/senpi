import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { type ExtensionAPI, SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/types.ts";
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

const answered = (saved: SessionManager): void => {
	saved.appendMessage(answer("Done for now"));
};
const toolCallPending = (saved: SessionManager): void => {
	saved.appendMessage(toolCallAnswer());
};

const ended: Array<[string, (saved: SessionManager) => void]> = [
	["its answer was written", answered],
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
	["a tool call had no result", toolCallPending],
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

function monitorWake(h: Harness): Promise<void> {
	return h.session.sendCustomMessage(
		{ customType: "senpi-monitor:event", content: "build finished", display: false },
		{ triggerTurn: true },
	);
}

// The reported lane had live monitors: their restored wakes were the first to reach the hold the reopen installed.
it("a monitor wake on a reopened idle session waits only under the unattended hold, which a peer message releases", async () => {
	const h = await reopened(answered);
	await monitorWake(h);
	expect(h.session.holds.map((hold) => hold.kind)).toEqual(["unattended"]);
	expect(h.session.pausedNoticeCount).toBe(1);
	const outcome = idleOrHeld(h);
	expect(
		h.session.externalAdmission.admit({ delivery_id: "move-3", text: "[from lead] continue", deliverAs: "followUp" }),
	).toMatchObject({ kind: "started" });
	expect(await outcome).toBe("idle");
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.paused).toBe(false);
});

it("a monitor wake on a session reopened mid-run is held for the person", async () => {
	const h = await reopened(toolCallPending);
	await monitorWake(h);
	expect(h.session.holds.map((hold) => hold.key)).toContain("interrupted-run");
	expect(h.session.pausedNoticeCount).toBe(1);
	expect(h.faux.state.callCount).toBe(0);
});

/** The interrupted session reopened behind a real RPC connection, the transport the thread tools' host uses. */
async function interruptedOverRpc(extension?: (api: ExtensionAPI) => void, seed?: (saved: SessionManager) => void) {
	const { base, file } = await killedSessionFile((saved) => {
		seed?.(saved);
		toolCallPending(saved);
	});
	const fixture = await createIdentityHarness({
		siblingOf: base,
		...(extension === undefined ? {} : { extensionFactories: [extension] }),
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

it.each(["person", "parent"] as const)(
	"a %s Stop during interrupted resume admission retains all work",
	async (owner) => {
		const { fixture } = await interruptedOverRpc();
		const { session } = fixture;
		fixture.harness.setResponses([fauxAssistantMessage("unexpected turn")]);
		await monitorWake(fixture.harness);
		session.holdInput({ inputId: "pending", revision: 0, text: "use staging" });
		const resume = session.beginResume({
			expectedSeq: session.pauseView.pauseSeq,
			unlessStopped: true,
			effectId: "r",
		});
		// A held input makes preparation asynchronous. Place the Stop before the prepared turn reaches the model.
		if (owner === "person") await session.stop();
		else await session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef: { kind: "task", id: "t" } });
		const { answer, settled } = await resume;
		await settled;
		expect({
			resumed: answer.resumed,
			reason: answer.reason,
			started: answer.turnStarted,
			modelCalls: fixture.harness.faux.state.callCount,
			inputs: session.pausedHeldInputCount,
			notices: session.pausedNoticeCount,
			stopHeld: session.automaticInputHoldLive(),
		}).toEqual({
			resumed: false,
			reason: "stopped",
			started: false,
			modelCalls: 0,
			inputs: 1,
			notices: 1,
			stopHeld: true,
		});
	},
);

it("replays a successful guarded effect without running a second turn", async () => {
	const { fixture, rpc } = await interruptedOverRpc();
	expect(await rpc.send({ type: "get_protocol_info" })).toMatchObject({
		data: { capabilities: expect.arrayContaining(["resume_session_guarded_admission_v1"]) },
	});
	expect(await rpc.send({ type: "get_state" })).toMatchObject({ data: { pause: { guardedResumeAdmission: 1 } } });
	fixture.harness.setResponses([fauxAssistantMessage("recovered")]);
	const input = { inputId: "same-input", revision: 0, text: "unique held instruction" };
	expect(fixture.session.holdInput(input)).toMatchObject({ kind: "held", duplicate: false });
	expect(fixture.session.holdInput(input)).toMatchObject({ kind: "held", duplicate: true });
	await monitorWake(fixture.harness);
	const request = {
		type: "resume_session",
		mode: "interrupted",
		expectedSeq: fixture.session.pauseView.pauseSeq,
		unlessStopped: true,
		effectId: "r",
	};
	expect(await rpc.send({ ...request, unlessStopped: false })).toMatchObject({ success: false });
	expect(await rpc.send({ ...request, expectedSeq: undefined })).toMatchObject({ success: false });
	expect(await rpc.send(request)).toMatchObject({ data: { resumed: true, turnStarted: true } });
	await fixture.session.resumeSettled();
	expect(await rpc.send(request)).toMatchObject({ data: { resumed: true, replayed: true } });
	expect(fixture.harness.faux.state.callCount).toBe(1);
	expect(fixture.session.holdInput(input)).toMatchObject({ kind: "already_delivered" });
	expect(fixture.session.pausedNoticeCount).toBe(0);
	const transcript = JSON.stringify(fixture.session.messages);
	expect(transcript.match(/unique held instruction/g)).toHaveLength(1);
	expect(transcript.match(/build finished/g)).toHaveLength(1);
});

it("a peer leaves a prepared extension command and the interrupted turn for human resume", async () => {
	let commands = 0;
	const { fixture, rpc } = await interruptedOverRpc(
		(api) =>
			api.registerCommand("side-effect", {
				description: "record",
				handler: async () => {
					commands++;
				},
			}),
		(saved) =>
			saved.appendCustomEntry("held-input", {
				inputId: "command",
				revision: 0,
				text: "/side-effect",
				prepare: true,
			}),
	);
	const resume = await rpc.send({
		type: "resume_session",
		mode: "interrupted",
		expectedSeq: fixture.session.pauseView.pauseSeq,
		unlessStopped: true,
	});
	expect(resume).toMatchObject({ data: { resumed: false, reason: "held_command" } });
	expect(commands).toBe(0);
	expect(fixture.harness.faux.state.callCount).toBe(0);
	expect(fixture.session.holds.some((hold) => hold.key === "interrupted-run")).toBe(true);
	expect(fixture.session.pausedHeldInputCount).toBe(1);
});

it.each(["person", "parent"] as const)(
	"a %s Stop at final admission retains the wake and input, including after restart",
	async (owner) => {
		const atAdmission = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const { fixture, rpc } = await interruptedOverRpc((api) => {
			api.on("before_agent_start", async () => {
				atAdmission.resolve();
				await proceed.promise;
			});
		});
		fixture.harness.setResponses([fauxAssistantMessage("unexpected")]);
		await monitorWake(fixture.harness);
		fixture.session.holdInput({ inputId: "late", revision: 0, text: "still pending" });
		const resume = rpc.send({
			type: "resume_session",
			unlessStopped: true,
			expectedSeq: fixture.session.pauseView.pauseSeq,
		});
		await atAdmission.promise;
		const stop =
			owner === "person"
				? fixture.session.stop()
				: fixture.session.pauseForRun({
						parentSessionId: "p",
						parentPauseSeq: 2,
						runRef: { kind: "task", id: "t" },
					});
		proceed.resolve();
		await stop;
		expect(await resume).toMatchObject({ data: { resumed: false, reason: "stopped", turnStarted: false } });
		await fixture.session.resumeSettled();
		expect(fixture.harness.faux.state.callCount).toBe(0);
		expect(fixture.session.automaticInputHoldLive()).toBe(true);
		expect(fixture.session.pausedNoticeCount).toBe(1);
		expect(fixture.session.pausedHeldInputCount).toBe(1);
		const reopened = await fixture.reopen();
		await reopened.handler.ready;
		await fixture.session.waitForIdle();
		expect(await reopened.send({ type: "get_state", observe: true })).toMatchObject({
			data: { paused: true, pausedNoticeCount: 1, pausedHeldInputCount: 1 },
		});
		expect(fixture.session.holdInput({ inputId: "late", revision: 0, text: "still pending" })).toMatchObject({
			kind: "held",
			duplicate: true,
		});
		expect(
			fixture.session.workObligations.active.some((item) => item.payload?.message.customType === "session-resumed"),
		).toBe(false);
		expect(fixture.session.messages.some((m) => m.role === "custom" && m.customType === "session-resumed")).toBe(
			false,
		);
		expect(fixture.harness.faux.state.callCount).toBe(0);
	},
);

it("guarded notice-only resume reports final admission refusal, not a started turn", async () => {
	const entered = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const fixture = await createIdentityHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		extensionFactories: [
			(api) => {
				api.on("before_agent_start", async () => {
					entered.resolve();
					await proceed.promise;
				});
			},
		],
	});
	cleanups.push(fixture.cleanup);
	const rpc = fixture.bind();
	await rpc.handler.ready;
	await monitorWake(fixture.harness);
	expect(fixture.session.holds.map((hold) => hold.key)).toEqual(["unattended"]);
	fixture.harness.setResponses([fauxAssistantMessage("unexpected")]);
	const resume = rpc.send({
		type: "resume_session",
		unlessStopped: true,
		expectedSeq: fixture.session.pauseView.pauseSeq,
		effectId: "notice-only",
	});
	await entered.promise;
	const stop = fixture.session.stop();
	proceed.resolve();
	await stop;
	const reply = await resume;
	expect({
		calls: fixture.harness.faux.state.callCount,
		held: fixture.session.pausedNoticeCount,
		stopped: fixture.session.automaticInputHoldLive(),
	}).toEqual({ calls: 0, held: 1, stopped: true });
	expect(reply).toMatchObject({
		data: { resumed: false, reason: "stopped", turnStarted: false, deliveredNotices: 0, deliveredHeldInputs: 0 },
	});
	const retry = await rpc.send({
		type: "resume_session",
		unlessStopped: true,
		expectedSeq: fixture.session.pauseView.pauseSeq,
		effectId: "notice-only",
	});
	expect(retry).toMatchObject({ data: { resumed: false, reason: "stopped", turnStarted: false } });
});

it("acknowledges a guarded notice-only turn at admission without waiting for settlement", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const fixture = await createIdentityHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		tools: [
			{
				name: "gate",
				label: "gate",
				description: "Hold until released",
				parameters: Type.Object({}),
				execute: async () => {
					started.resolve();
					await finish.promise;
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			},
		],
	});
	cleanups.push(fixture.cleanup);
	const rpc = fixture.bind();
	await rpc.handler.ready;
	await monitorWake(fixture.harness);
	fixture.harness.setResponses([
		fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("finished"),
	]);
	const resume = rpc.send({
		type: "resume_session",
		unlessStopped: true,
		expectedSeq: fixture.session.pauseView.pauseSeq,
	});
	try {
		await started.promise;
		expect(await resume).toMatchObject({ data: { resumed: true, turnStarted: true, deliveredNotices: 1 } });
		expect(fixture.session.isStreaming).toBe(true);
	} finally {
		finish.resolve();
		await fixture.session.waitForIdle();
	}
});
