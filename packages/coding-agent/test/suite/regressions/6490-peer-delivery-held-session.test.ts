import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

async function unattended(): Promise<Harness> {
	const h = await createHarness({
		persistSession: true,
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(h);
	h.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage([fauxText("done")])));
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

function deliveries(h: Harness): unknown[] {
	return h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE)
		.map((entry) => (entry.type === "custom_message" ? entry.content : undefined));
}

// senpi#6490: three unattended sessions answered `started` to every peer `thread_send` and kept each one as a held
// notice, so a release train stalled. A peer message continues an unattended session, as the hold's own notice says.
it("a peer delivery to an unattended session releases the hold and starts its turn, with the held wakes before it", async () => {
	const h = await unattended();
	await h.session.sendCustomMessage(
		{ customType: "senpi-monitor:event", content: "build finished", display: false },
		{ triggerTurn: true },
	);
	expect(h.session.paused).toBe(true);
	expect(h.session.pausedNoticeCount).toBe(1);

	const outcome = idleOrHeld(h);
	const answer = h.session.externalAdmission.admit({
		delivery_id: "ny2-1",
		text: "[from lead] merge the train",
		deliverAs: "followUp",
	});
	expect(answer).toEqual({ kind: "started", turn_epoch: 0 });
	expect(await outcome).toBe("idle");

	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.paused).toBe(false);
	expect(h.session.pausedNoticeCount).toBe(0);
	expect(deliveries(h)).toEqual(["[from lead] merge the train"]);
	expect(h.session.externalAdmission.list()).toEqual({ pending: [], emitted: ["ny2-1"] });
	expect(h.events.some((event) => event.type === "session_resumed" && event.cause === "input")).toBe(true);
	// The held monitor wake rides into the same turn ahead of the delivery, as it does ahead of a person's message.
	const monitorIndex = h.session.messages.findIndex(
		(message) => message.role === "custom" && message.customType === "senpi-monitor:event",
	);
	const deliveryIndex = h.session.messages.findIndex(
		(message) => message.role === "custom" && message.customType === SESSION_CONTROL_DELIVERY_TYPE,
	);
	expect(monitorIndex).toBeGreaterThanOrEqual(0);
	expect(monitorIndex).toBeLessThan(deliveryIndex);
});

/** An unattended session whose Resume is stopped inside its first release turn, with the release barrier up. */
async function insideUnattendedResume(): Promise<{ h: Harness; resumed: Promise<unknown>; release: () => void }> {
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let starts = 0;
	const h = await createHarness({
		persistSession: true,
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					if (++starts !== 1) return;
					entered.resolve();
					await gate.promise;
				});
			},
		],
	});
	harnesses.push(h);
	h.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage([fauxText("done")])));
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await h.session.sendCustomMessage(
		{ customType: "senpi-monitor:event", content: "build finished", display: false },
		{ triggerTurn: true },
	);
	const resumed = h.session.resumeSession();
	await entered.promise;
	expect(h.session.paused).toBe(false);
	expect(h.session["_engineTurnHold"].releasing).toBe(true);
	return { h, resumed, release: () => gate.resolve() };
}

function emittedOrHeld(h: Harness, deliveryId: string): Promise<"emitted" | "held"> {
	return new Promise((resolve) => {
		const stopEmitted = h.session.externalAdmission.onEmitted((id) => {
			if (id !== deliveryId) return;
			stop();
			resolve("emitted");
		});
		const stopHeld = h.session.subscribe((event) => {
			if (event.type !== "session_notice" || event.disposition !== "notice_persisted") return;
			stop();
			resolve("held");
		});
		const stop = (): void => {
			stopEmitted();
			stopHeld();
		};
	});
}

// Review M1 on senpi#7014: inside an unattended Resume the release barrier holds every wake, so a peer delivery that
// found no recorded hold was answered `started` and still became a held notice. It attends the session and starts.
it("a peer delivery during an unattended Resume's release barrier attends the session and starts its own turn", async () => {
	const { h, resumed, release } = await insideUnattendedResume();
	const outcome = emittedOrHeld(h, "barrier-1");
	expect(
		h.session.externalAdmission.admit({
			delivery_id: "barrier-1",
			text: "[from lead] next step",
			deliverAs: "followUp",
		}),
	).toEqual({ kind: "started", turn_epoch: 0 });
	release();
	expect(await outcome).toBe("emitted");
	await resumed;
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(2);
	expect(deliveries(h)).toEqual(["[from lead] next step"]);
	expect(h.session.paused).toBe(false);
	expect(h.session.pausedNoticeCount).toBe(0);
});

it("an automatic wake during an unattended Resume's release barrier still waits for the next release", async () => {
	const { h, resumed, release } = await insideUnattendedResume();
	const noticesBefore = h.session.pausedNoticeCount;
	await h.session.sendCustomMessage(
		{ customType: "senpi-codemode:notification", content: "late completion", display: false },
		{ triggerTurn: true },
	);
	expect(h.session.pausedNoticeCount).toBe(noticesBefore + 1);
	release();
	await resumed;
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.paused).toBe(true);
	expect(h.session.pausedNoticeCount).toBe(1);
});

it.each(["senpi-monitor:event", "senpi-codemode:notification", "goal-continuation"])(
	"an automatic %s wake still stays held on an unattended session",
	async (customType) => {
		const h = await unattended();
		await h.session.sendCustomMessage({ customType, content: "wake", display: false }, { triggerTurn: true });
		expect(h.faux.state.callCount).toBe(0);
		expect(h.session.paused).toBe(true);
		expect(h.session.holds.map((hold) => hold.kind)).toEqual(["unattended"]);
		expect(h.session.pausedNoticeCount).toBe(1);
	},
);

it("a peer delivery under a person's Stop is answered held, stays a notice, and starts once when the person resumes", async () => {
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	h.session["_engineTurnHold"].addHold("session_hold", { key: "session_hold:1", data: { localSeq: 1 } });
	h.setResponses([fauxAssistantMessage([fauxText("resumed")])]);

	expect(
		h.session.externalAdmission.admit({ delivery_id: "stop-1", text: "[from lead] go on", deliverAs: "followUp" }),
	).toEqual({ kind: "held", holds: ["session_hold"], turn_epoch: 0 });
	expect(
		h.session.externalAdmission.admit({ delivery_id: "stop-1", text: "[from lead] go on", deliverAs: "followUp" })
			.kind,
	).toBe("already_admitted");
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(h.session.pausedNoticeCount).toBe(1);
	expect(deliveries(h)).toEqual([]);

	await h.session.resumeSession();
	await h.session.resumeSettled();
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.paused).toBe(false);
	expect(
		h.session.messages.filter(
			(message) => message.role === "custom" && JSON.stringify(message.content).includes("[from lead] go on"),
		),
	).toHaveLength(1);
});

it("a peer delivery after an interrupted run is answered held: continuing it needs a person", async () => {
	const h = await unattended();
	h.session["_lifecycleBinding"].controller.ledger.interrupted = true;
	expect(
		h.session.externalAdmission.admit({ delivery_id: "int-1", text: "[from lead] go on", deliverAs: "followUp" }),
	).toEqual({ kind: "held", holds: ["session_hold", "unattended"], turn_epoch: 0 });
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(h.session.holds.map((hold) => hold.key).sort()).toEqual(["interrupted-run", "unattended"]);
	expect(deliveries(h)).toEqual([]);
});
