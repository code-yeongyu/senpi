import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";
import { makeSink } from "../rpc-connection-harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function interruptedHost(customType?: string, interruptedDuringBinding = false) {
	const h = await createHarness({ persistSession: true });
	cleanups.push(h.cleanup);
	const saved = h.sessionManager;
	saved.appendMessage({ role: "user", content: "Original request", timestamp: 1 });
	saved.appendMessage(fauxAssistantMessage("Previous response"));
	if (!interruptedDuringBinding)
		saved.appendCustomEntry("session-lifecycle", {
			sessionId: saved.getSessionId(),
			state: "running",
			seq: 2,
			epoch: 1,
			epochOrigin: "human",
			humanInputRevision: 1,
			selfSettleEligible: true,
			runPaused: false,
			since: "2026-10-29T00:00:00.000Z",
			role: "root",
			rootSessionId: saved.getSessionId(),
			persisted: true,
			runActive: true,
			epochSealed: false,
			runId: "abandoned-run",
		});
	if (customType)
		saved.appendCustomEntry("work-custody", {
			sessionId: saved.getSessionId(),
			id: "queued-notification",
			key: `delivery:${customType}:queued`,
			kind: "background",
			state: "queued",
			ticketId: "queued-ticket",
			payload: { message: { customType, content: "Saved notification payload", display: false } },
		});
	const sessionPath = saved.getSessionFile();
	if (!sessionPath) throw new Error("The saved session has no path");
	h.session.dispose();
	const openedHarnesses: Harness[] = [];
	const registry = new RpcSessionRegistry({
		agentDir: h.session.agentDir,
		createRuntime: async (options) => {
			const fresh: Harness = await createHarness({
				cwd: options.cwd,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				extensionFactories: interruptedDuringBinding
					? [
							(pi) => {
								pi.on("session_start", () => {
									const transcriptEntryId = options.sessionManager.getLeafId();
									if (!transcriptEntryId) throw new Error("Missing saved transcript");
									const ticket = fresh.session.workObligations
										.open("delivery:late-consumed", "background")
										.ticket();
									fresh.session.workObligations.consumed(ticket, {
										runId: "abandoned-run",
										transcriptEntryId,
									});
								});
							},
						]
					: [],
			});
			openedHarnesses.push(fresh);
			return {
				session: fresh.session,
				extensionsResult: fresh.session.resourceLoader.getExtensions(),
				services: {
					cwd: options.cwd,
					agentDir: options.agentDir,
					authStorage: fresh.authStorage,
					modelRegistry: fresh.modelRegistry,
					modelRuntime: fresh.session.modelRuntime,
					settingsManager: fresh.settingsManager,
					resourceLoader: fresh.session.resourceLoader,
					diagnostics: [],
				},
				diagnostics: [],
			};
		},
	});
	const collected = makeSink();
	const writer = new SessionEventWriter(collected.sink.writeRaw);
	const router = new SessionCommandRouter(registry, writer, { cwd: h.session.cwd });
	let request = 0;
	const send = async (command: RpcCommand) => {
		const id = `request-${++request}`;
		const reply = collected.waitFor((record) => record.id === id, 10_000);
		const immediate = await router.handle({ ...command, id });
		if (immediate) collected.sink.writeRaw(`${JSON.stringify(immediate)}\n`);
		return reply;
	};
	cleanups.push(async () => {
		await router.dispose();
		for (const fresh of openedHarnesses) fresh.cleanup();
	});
	const opened = await send({ type: "open_session", sessionPath });
	return {
		get h() {
			const fresh = openedHarnesses.at(-1);
			if (!fresh) throw new Error("No session harness was constructed");
			return fresh;
		},
		opened,
		send,
		registry,
		sessionPath,
		current() {
			const row = registry.list()[0];
			if (!row) throw new Error("The registry has no open session");
			const runtime = registry.peek(row.sessionId)?.runtime;
			if (!runtime) throw new Error("The registry has no runtime");
			return { sessionId: row.sessionId, session: runtime.session };
		},
	};
}

// #4731: recovery can discover consumed work after bindExtensions' initial hold check.
it("installs the interrupted hold when restore discovers consumed work during binding", async () => {
	const fixture = await interruptedHost(undefined, true);
	expect(fixture.opened).toMatchObject({ success: true });
	const { session } = fixture.current();
	expect(session.lifecycle.waitingOn?.human).toContainEqual(expect.objectContaining({ kind: "interrupted_run" }));
	expect(session.holds.map((hold) => hold.key)).toEqual(["interrupted-run"]);
	expect(fixture.h.faux.state.callCount).toBe(0);
});

// #4731: the real open_session registry/binding path restores custody and replays notifications before replying.
// A replayed Resume directive is not fresh human input, even though its custom type is user-directed.
it.each(["senpi-monitor:event", "session-resumed"])(
	"opens an interrupted session with queued %s and delivers it once after Resume",
	async (customType) => {
		const fixture = await interruptedHost(customType);
		expect(fixture.opened, JSON.stringify(fixture.opened)).toMatchObject({ success: true, command: "open_session" });
		let { session, sessionId } = fixture.current();
		expect(fixture.h.faux.state.callCount).toBe(0);
		expect(session.holds.map((hold) => hold.key)).toEqual(["interrupted-run"]);
		expect(session.pausedNoticeCount).toBe(1);
		expect(session.workObligations.active.some((record) => record.ticketId === "queued-ticket")).toBe(false);
		expect(session.messages.some((message) => getMessageText(message) === "Saved notification payload")).toBe(false);

		await fixture.send({ type: "close_session", sessionId });
		expect(await fixture.send({ type: "open_session", sessionPath: fixture.sessionPath })).toMatchObject({
			success: true,
		});
		({ session, sessionId } = fixture.current());
		expect(fixture.h.faux.state.callCount).toBe(0);
		expect(session.pausedNoticeCount).toBe(1);
		fixture.h.setResponses([fauxAssistantMessage("Recovered")]);
		const response = await fixture.send({ type: "resume_session", sessionId });
		await session.resumeSettled();
		expect(response).toMatchObject({
			success: true,
			data: { resumed: true, turnStarted: true, deliveredNotices: 1 },
		});
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(session.pausedNoticeCount).toBe(0);
		expect(
			session.messages.filter((message) => getMessageText(message).includes("Saved notification payload")),
		).toHaveLength(1);
	},
);

// #4732: PR #4206 already excludes interrupted-run from the automatic RPC input gate. Protect it at the
// full registry/open + prompt + release boundary, both for old clients and interactive_user connections.
it.each([false, true])(
	"delivers the first RPC prompt once during interruption (interactive: %s)",
	async (interactive) => {
		const fixture = await interruptedHost();
		expect(fixture.opened).toMatchObject({ success: true });
		const { session, sessionId } = fixture.current();
		if (interactive) await fixture.send({ type: "set_client_info", width: 100, capabilities: ["interactive_user"] });
		expect(session.paused).toBe(true);
		fixture.h.setResponses([fauxAssistantMessage("Human request delivered")]);
		const idle = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_idle") idle.resolve();
		});
		try {
			const response = await fixture.send({ type: "prompt", sessionId, message: "First human prompt" });
			expect(response).toMatchObject({ success: true, data: { disposition: "started" } });
			await idle.promise;
		} finally {
			unsubscribe();
		}
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(session.paused).toBe(false);
		expect(session.pausedNoticeCount).toBe(0);
		expect(session.messages.filter((message) => getMessageText(message) === "First human prompt")).toHaveLength(1);
		const released = await fixture.send({ type: "resume_session", sessionId, mode: "release" });
		expect(released).toMatchObject({
			success: true,
			data: { resumed: false, reason: "not_paused", turnStarted: false, deliveredHeldInputs: 0 },
		});
		expect(fixture.h.faux.state.callCount).toBe(1);
	},
);
