import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

async function unattended(): Promise<Harness> {
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(h);
	h.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage([fauxText("done")])));
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	return h;
}

// senpi#3853: every engine source must cross the same admission gate.
it.each(["senpi-monitor:notification", "senpi-codemode:notification", "goal-continuation"])(
	"holds an unattended %s wake without reaching the provider",
	async (customType) => {
		const h = await unattended();
		await h.session.sendCustomMessage({ customType, content: "wake", display: false }, { triggerTurn: true });
		expect(h.faux.state.callCount).toBe(0);
		expect(
			h.events.filter(
				(e) => e.type === "entry_appended" && e.entry.type === "custom" && e.entry.customType === "session-notice",
			),
		).toHaveLength(1);
	},
);

it("releases coalesced wakes only after real input", async () => {
	const h = await unattended();
	for (let i = 0; i < 5; i++)
		await h.session.sendCustomMessage(
			{ customType: "senpi-codemode:notification", content: `completion ${i}`, display: false },
			{ triggerTurn: true },
		);
	await h.session.prompt("continue");
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(1);
	expect(
		h.session.messages.filter((m) => m.role === "custom" && m.customType === "senpi-codemode:notification"),
	).toHaveLength(1);
	const contextIndex = h.session.messages.findIndex(
		(m) => m.role === "custom" && m.customType === "senpi-codemode:notification",
	);
	const inputIndex = h.session.messages.findIndex((m) => m.role === "user");
	expect(contextIndex).toBeLessThan(inputIndex);
	expect(h.session.messages[contextIndex]).toMatchObject({ content: "completion 4" });
});

it("ten wakes from two sources stay held on attach, then Resume runs one turn per source even in all mode", async () => {
	const h = await unattended();
	h.agent.followUpMode = "all";
	const pausedAtStart: boolean[] = [];
	h.session.subscribe((event) => {
		if (event.type === "agent_start") pausedAtStart.push(h.session.paused);
	});
	for (let i = 0; i < 5; i++) {
		for (const source of ["senpi-monitor:event", "senpi-codemode:notification"]) {
			await h.session.sendCustomMessage(
				{ customType: source, content: `latest ${i}`, display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
	}
	await h.session.extensionRunner.emit({ type: "session_resumed" });
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(h.session.pausedNoticeCount).toBe(10);
	expect(h.session.holds).toEqual([
		{
			kind: "unattended",
			key: "unattended",
			since: expect.any(String),
			sourceCounts: { monitor: 5, codemode: 5 },
		},
	]);
	await h.session.resumeSession();
	expect(h.faux.state.callCount).toBe(2);
	expect(h.events.filter((event) => event.type === "agent_start")).toHaveLength(2);
	expect(pausedAtStart).toEqual([false, false]);
	expect(h.events.some((event) => event.type === "session_resumed" && event.cause === "resume_session")).toBe(true);
	const monitor = h.session.messages.filter((m) => m.role === "custom" && m.customType === "senpi-monitor:event");
	expect(monitor).toHaveLength(1);
	expect(monitor[0]).toMatchObject({ content: "5 automatic monitor wakes held. Latest event:\nlatest 4" });
});

it("keeps notice custody when the resume-window cap refuses delivery", async () => {
	const h = await unattended();
	for (let i = 0; i < 8; i++) {
		h.sessionManager.appendCustomEntry("engine-turn-start", { customType: "senpi-monitor:event", at: Date.now() });
	}
	await h.session.sendCustomMessage(
		{ customType: "senpi-codemode:notification", content: "retain this completion", display: false },
		{ triggerTurn: true },
	);
	await h.session.resumeSession();
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(h.session.pausedNoticeCount).toBe(1);
	expect(
		h.session.messages.filter((m) => m.role === "custom" && m.customType === "senpi-codemode:notification"),
	).toEqual([]);
});

it("retains the held wake count after a second unattended reopen", async () => {
	const a = await createHarness({ persistSession: true });
	harnesses.push(a);
	a.setResponses([fauxAssistantMessage([fauxText("seeded")])]);
	await a.session.prompt("seed");
	const file = a.sessionManager.getSessionFile();
	if (!file) throw new Error("expected a persisted file");
	a.session.dispose();
	const b = await createHarness({
		siblingOf: a,
		sessionManager: SessionManager.open(file),
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(b);
	await b.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	const before = b.faux.state.callCount;
	for (let i = 0; i < 3; i++)
		await b.session.sendCustomMessage(
			{ customType: "senpi-codemode:notification", content: `completion ${i}`, display: false },
			{ triggerTurn: true },
		);
	const since = new Date().toISOString();
	b.sessionManager.appendCustomEntry("session-hold", {
		op: "add",
		kind: "unattended",
		key: "unattended:park",
		data: { origin: "handover" },
		pauseSeq: 2,
		at: since,
	});
	b.session.dispose();
	const c = await createHarness({
		siblingOf: a,
		sessionManager: SessionManager.open(file),
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(c);
	await c.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	expect(c.faux.state.callCount).toBe(before);
	expect(
		c.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && e.customType === "session-notice")
			.map((e) => e.type === "custom" && e.data),
	).toHaveLength(3);
	c.setResponses([fauxAssistantMessage([fauxText("resumed")])]);
	expect(c.session.pausedNoticeCount).toBe(3);
	expect(c.session.holds).toEqual(
		expect.arrayContaining([
			{
				kind: "unattended",
				key: "unattended:park",
				since,
				data: { origin: "handover" },
				sourceCounts: { codemode: 3 },
			},
		]),
	);
	await c.session.resumeSession();
	expect(c.faux.state.callCount - before).toBe(1);
	expect(c.session.holds).toEqual([]);
	expect(
		c.sessionManager
			.getEntries()
			.findLast(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "session-hold" &&
					(entry.data as { op?: string }).op === "release",
			),
	).toMatchObject({ data: { keys: ["unattended", "unattended:park"] } });
});
