import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/session-control-types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { admitExternalMessage } from "../../../src/modes/rpc/admit-external-message-command.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function nextEvent(h: Harness, type: "session_notice" | "agent_idle"): Promise<void> {
	return new Promise((resolve) => {
		const stop = h.session.subscribe((event) => {
			if (event.type !== type) return;
			stop();
			resolve();
		});
	});
}

async function reopen(h: Harness): Promise<Harness> {
	const file = h.sessionManager.getSessionFile();
	if (!file) throw new Error("expected a persistent session");
	h.session.dispose();
	return createHarness({ siblingOf: h, sessionManager: SessionManager.open(file) });
}

function deliveredBriefs(h: Harness) {
	return h.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE ? [entry.content] : [],
		);
}

// #7513: publication happens after custody has committed, even if the RPC observer fails.
it("acknowledges committed custody when an entry subscriber throws", async () => {
	const h = await createHarness({ persistSession: true });
	await h.session.bindExtensions({ mode: "rpc" });
	await h.sessionManager.persistHeaderNow();
	const peer = { connectionOrigin: "local", origin: undefined } as const;
	const command = {
		type: "admit_external_message",
		deliveryId: "once",
		text: "one brief",
		deliverAs: "followUp",
		whenIdle: "queue",
	} as const;
	let notifications = 0;
	const stop = h.session.subscribe((event) => {
		if (
			event.type === "entry_appended" &&
			event.entry.type === "custom" &&
			event.entry.customType === "work-custody"
		) {
			notifications++;
			throw new Error("subscriber failed after append");
		}
	});
	const receipt = admitExternalMessage(h.session, command, peer);
	stop();
	expect(notifications).toBe(1);
	expect(receipt).toMatchObject({ ok: true, data: { kind: "queued" } });
	expect(admitExternalMessage(h.session, command, peer)).toMatchObject({ data: { kind: "already_admitted" } });
	const restored = await reopen(h);
	expect(restored.session.workObligations.active.filter((record) => record.external)).toHaveLength(1);
	expect(admitExternalMessage(restored.session, command, peer)).toMatchObject({ data: { kind: "already_admitted" } });
	restored.setResponses([fauxAssistantMessage("ready"), fauxAssistantMessage("received")]);
	await restored.session.prompt("take queued work");
	expect(deliveredBriefs(restored)).toEqual([command.text]);
});

it.each([false, true])("recovers a delivery id once from duplicate tickets (already written=%s)", async (written) => {
	const h = await createHarness({ persistSession: true });
	await h.sessionManager.persistHeaderNow();
	const input = { delivery_id: "duplicate", text: "one brief", deliverAs: "followUp", whenIdle: "queue" } as const;
	expect(h.session.externalAdmission.admit(input).kind).toBe("queued");
	const record = h.session.workObligations.active.find((entry) => entry.external);
	if (!record) throw new Error("expected external ticket");
	// A file left by an older receiver that returned a refusal after its first commit.
	h.sessionManager.appendCustomEntry("work-custody", {
		...record,
		sessionId: h.session.sessionId,
		id: "second",
		ticketId: "second",
	});
	if (written) {
		h.setResponses([fauxAssistantMessage("ready"), fauxAssistantMessage("received")]);
		await h.session.prompt("take original");
	}
	const restored = await reopen(h);
	restored.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("ack")));
	await restored.session.prompt("take recovered work");
	expect(deliveredBriefs(restored)).toEqual([input.text]);
	expect(restored.session.workObligations.active.filter((entry) => entry.external)).toEqual([]);
});

// #7513: the sender no longer has either brief. Recovery must settle each separately.
it("delivers later restored work when the first replay rejects and retries only the failed brief", async () => {
	const h = await createHarness({ persistSession: true });
	await h.sessionManager.persistHeaderNow();
	vi.spyOn(h.session, "sendCustomMessage").mockResolvedValue(undefined);
	for (const [index, id] of ["first brief", "second brief"].entries()) {
		expect(h.session.externalAdmission.admit({ delivery_id: id, text: id, deliverAs: "followUp" }).kind).toBe(
			index === 0 ? "started" : "steered",
		);
	}
	const restored = await reopen(h);
	restored.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("ack")));
	vi.spyOn(restored.session, "sendCustomMessage").mockRejectedValueOnce(new Error("first replay refused"));
	await expect(restored.session.bindExtensions({ mode: "rpc" })).resolves.toBeUndefined();
	expect(deliveredBriefs(restored)).toEqual(["second brief"]);
	await restored.session.prompt("next input");
	expect(deliveredBriefs(restored)).toEqual(["second brief", "first brief"]);
	expect(restored.session.externalAdmission.list()).toEqual({ pending: [], emitted: ["second brief", "first brief"] });
});

// #7513: the sender drops its copy on a positive receipt. Only the file crosses this boundary.
it.each(["start", "queue"] as const)(
	"keeps the first %s delivery across unload before its transcript entry",
	async (whenIdle) => {
		const original = await createHarness({ persistSession: true });
		const file = original.sessionManager.getSessionFile();
		if (!file) throw new Error("expected a persistent session");
		await original.sessionManager.persistHeaderNow();
		const command = {
			type: "admit_external_message",
			deliveryId: "brief",
			text: "FIRST-BRIEF",
			deliverAs: "followUp",
			whenIdle,
		} as const;
		const peer = { connectionOrigin: "local", origin: undefined } as const;
		// The launch settles without ever writing or taking the message. Admission must still own the payload.
		vi.spyOn(original.session, "sendCustomMessage").mockResolvedValue(undefined);
		expect(admitExternalMessage(original.session, command, peer)).toMatchObject({
			ok: true,
			data: { kind: whenIdle === "start" ? "started" : "queued" },
		});
		await original.session.waitForIdle();
		expect(await original.sessionManager.discardHeaderOnlyFile()).toBe(false);
		original.session.dispose();
		const reopened = await createHarness({ siblingOf: original, sessionManager: SessionManager.open(file) });
		const requests: string[][] = [];
		const record: FauxResponseStep = (context) => {
			requests.push(context.messages.map(getMessageText).filter((text) => text.includes(command.text)));
			return fauxAssistantMessage("received");
		};
		// A follow-up waits until the turn that takes the user's input has answered.
		reopened.setResponses([record, record]);
		await reopened.session.bindExtensions({ mode: "rpc" });
		if (whenIdle === "queue") {
			expect(requests).toEqual([]);
			await reopened.session.prompt("take queued work");
		}
		await reopened.session.waitForIdle();
		expect(requests.flat()).toHaveLength(1);
		expect(admitExternalMessage(reopened.session, command, peer)).toMatchObject({
			ok: true,
			data: { kind: "already_admitted" },
		});
	},
);

it("re-arms a missed idle launch without another sender or a reload", async () => {
	const h = await createHarness({ persistSession: true });
	h.setResponses([fauxAssistantMessage("received")]);
	vi.spyOn(h.session, "sendCustomMessage").mockResolvedValueOnce(undefined);
	const idle = nextEvent(h, "agent_idle");
	expect(
		h.session.externalAdmission.admit({ delivery_id: "rearm", text: "start once", deliverAs: "followUp" }).kind,
	).toBe("started");
	await idle;
	expect(h.session.externalAdmission.list()).toEqual({ pending: [], emitted: ["rearm"] });
	expect(h.faux.state.callCount).toBe(1);
});

it("refuses a delivery whose custody write races the initial header, then accepts the sender's retry", async () => {
	const h = await createHarness({ persistSession: true });
	const peer = { connectionOrigin: "local", origin: undefined } as const;
	const command = {
		type: "admit_external_message",
		deliveryId: "retry",
		text: "retry me",
		deliverAs: "followUp",
	} as const;
	const writing = h.sessionManager.persistHeaderNow();
	const refused = admitExternalMessage(h.session, command, peer);
	await writing;
	expect(refused).toMatchObject({ ok: false, refusal: { errorCode: "delivery_not_persisted" } });
	expect(h.session.externalAdmission.list().pending).toEqual([]);
	h.setResponses([fauxAssistantMessage("received")]);
	const idle = nextEvent(h, "agent_idle");
	expect(admitExternalMessage(h.session, command, peer)).toMatchObject({ ok: true, data: { kind: "started" } });
	await idle;
	expect(h.session.externalAdmission.list().emitted).toEqual(["rpc:local/retry"]);
});

it("does not promise custody for a session that has no storage", async () => {
	const h = await createHarness();
	expect(
		admitExternalMessage(
			h.session,
			{
				type: "admit_external_message",
				deliveryId: "volatile",
				text: "keep me",
				deliverAs: "steer",
				whenIdle: "queue",
			},
			{ connectionOrigin: "local", origin: undefined },
		),
	).toMatchObject({ ok: false, refusal: { errorCode: "delivery_not_persisted" } });
	expect(h.session.externalAdmission.list().pending).toEqual([]);
	expect(h.agent.hasQueuedMessages()).toBe(false);
});

it("holds each acknowledged brief until Resume, including across a reopen", async () => {
	const h = await createHarness({ persistSession: true });
	const file = h.sessionManager.getSessionFile();
	if (!file) throw new Error("expected a persistent session");
	await h.session.bindExtensions({ mode: "rpc" });
	h.session["_engineTurnHold"].addHold("session_hold", { key: "session_hold:1" });
	const input = (id: string) => ({ delivery_id: id, text: id, deliverAs: "followUp" }) as const;
	for (const id of ["brief-one", "brief-two"]) {
		const notice = nextEvent(h, "session_notice");
		expect(h.session.externalAdmission.admit(input(id)).kind).toBe("held");
		await notice;
	}
	h.session.dispose();
	const reopened = await createHarness({ siblingOf: h, sessionManager: SessionManager.open(file) });
	const delivered: string[] = [];
	reopened.setResponses([
		(context) => {
			delivered.push(
				...context.messages.flatMap((message) => getMessageText(message).match(/brief-(one|two)/g) ?? []),
			);
			return fauxAssistantMessage("ack");
		},
	]);
	await reopened.session.bindExtensions({ mode: "rpc" });
	expect(reopened.faux.state.callCount).toBe(0);
	expect(reopened.session.externalAdmission.admit(input("brief-one")).kind).toBe("already_admitted");
	await reopened.session.resumeSession();
	expect(delivered).toEqual(["brief-one", "brief-two"]);
	expect(reopened.session.externalAdmission.list()).toEqual({ pending: [], emitted: delivered });
	reopened.session.dispose();
	const finished = await createHarness({ siblingOf: h, sessionManager: SessionManager.open(file) });
	expect(finished.session.externalAdmission.admit(input("brief-two")).kind).toBe("already_admitted");
});
