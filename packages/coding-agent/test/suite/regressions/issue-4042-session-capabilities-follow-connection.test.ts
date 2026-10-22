/**
 * omo-desktop-app#4042 (b): client capabilities are per connection. A question goes as a native frame to the
 * attached connections that declared `question` and degrades only while none of them is attached; extension
 * events and the custom-unsupported notice follow the same rule. An observer's declaration, and one the
 * senpi#3811 role check refuses, change nothing.
 */
import { describe, expect, it } from "vitest";
import { INTERACTIVE_USER_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import { type Client, nextDialog, openShared, RUNTIMES, run, withHost } from "./issue-4042-host-support.ts";

function ask(client: Client, sessionId: unknown) {
	return run(client, sessionId, "/ask-question");
}

function questionFrames(client: Client, sessionId: unknown) {
	return client.records.filter(
		(record) =>
			record.type === "extension_ui_request" && record.method === "question" && record.sessionId === sessionId,
	);
}

describe.each(RUNTIMES)("%s runtime", (sessionRuntime) => {
	it("an opener that declares question after opening gets the native question frame", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: a session opened by a connection that sent no set_client_info, so it asks degraded.
			const owner = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;

			// When: that connection declares `question` and the session asks.
			const info = await owner.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const dialog = nextDialog(owner, sessionId);
			const prompt = ask(owner, sessionId);

			// Then: one native frame, no reply the client did not ask for, and the answer settles the prompt.
			expect([opened.success, info.success]).toEqual([true, true]);
			const request = await dialog;
			expect(request.method).toBe("question");
			expect(
				owner.records.filter((record) => record.type === "response" && record.command === "set_client_info"),
			).toHaveLength(1);
			owner.send({ type: "extension_ui_response", sessionId, id: request.id, answers: { q1: { selected: ["A"] } } });
			expect((await prompt).success).toBe(true);
		});
	}, 120_000);

	it("a later connection without question does not downgrade the answerer, and never sees the native frame", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: A declared question and opened the session; B declared only extension_events and attached later.
			const a = await host.connect();
			const b = await host.connect();
			await a.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			await b.request({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
			const { sessionId } = await openShared(host, a, b);

			// When: the session asks a question.
			const dialog = nextDialog(a, sessionId);
			const status = b.wait((record) => record.message === "QUESTION_STATUS=answered");
			const prompt = ask(a, sessionId);
			const request = await dialog;
			a.send({ type: "extension_ui_response", sessionId, id: request.id, answers: { q1: { selected: ["A"] } } });

			// Then: A gets it natively, B never receives the native frame, and A's answer settles it once.
			expect(request.method).toBe("question");
			expect((await prompt).success).toBe(true);
			await status;
			expect(questionFrames(b, sessionId)).toEqual([]);
			expect(
				b.records.filter((record) => record.type === "question_resolved" && record.id === request.id),
			).toHaveLength(1);
		});
	}, 120_000);

	it("the answerer leaving mid-question cancels it once, and the next question degrades to who is left", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: A (question) and B (none) attached, with a native question pending on A.
			const a = await host.connect();
			const b = await host.connect();
			await a.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			await b.request({ type: "set_client_info", width: 80, capabilities: [] });
			const { sessionId } = await openShared(host, a, b);
			const pendingOnA = nextDialog(a, sessionId);
			const cancelled = b.wait((record) => record.message === "QUESTION_STATUS=cancelled");
			const first = ask(b, sessionId);
			const request = await pendingOnA;
			expect(request.method).toBe("question");

			// When: A releases its attachment before answering.
			expect(await a.request({ type: "release_attachment", sessionId })).toMatchObject({ success: true });

			// Then: the pending question settles cancelled exactly once, and the next one asks B degraded.
			await cancelled;
			expect((await first).success).toBe(true);
			expect(b.records.filter((record) => record.type === "question_resolved" && record.id === request.id)).toEqual([
				expect.objectContaining({ outcome: "cancelled" }),
			]);
			const degraded = nextDialog(b, sessionId);
			ask(b, sessionId);
			expect((await degraded).method).toBe("select");
			expect(questionFrames(b, sessionId)).toEqual([]);
		});
	}, 120_000);

	it("a width-only set_client_info keeps the connection's declared question", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: A declared question and opened the session.
			const a = await host.connect();
			await a.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const opened = await a.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;
			const sessionPath = opened.data?.state?.sessionFile;

			// When: A resizes without capabilities, then attaches to the same session again.
			expect(await a.request({ type: "set_client_info", width: 120 })).toMatchObject({ success: true });
			expect(await a.request({ type: "open_session", cwd: host.cwd, sessionPath })).toMatchObject({
				success: true,
				data: { sessionId, attached: true },
			});
			const dialog = nextDialog(a, sessionId);
			ask(a, sessionId);

			// Then: the session still asks A natively.
			expect((await dialog).method).toBe("question");
		});
	}, 120_000);

	it("a connection that never declared still receives what it receives today", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: an undeclared connection (an old client) opened the session and a declared one attached.
			const legacy = await host.connect();
			const declared = await host.connect();
			await declared.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const { sessionId } = await openShared(host, legacy, declared);

			// When: the session asks while the declarer is attached.
			const onLegacy = nextDialog(legacy, sessionId);
			const onDeclared = nextDialog(declared, sessionId);
			const first = ask(declared, sessionId);
			const frame = await onDeclared;

			// Then: the old client gets the same native frame as today, and either answer settles it.
			expect(frame.method).toBe("question");
			expect((await onLegacy).id).toBe(frame.id);
			legacy.send({ type: "extension_ui_response", sessionId, id: frame.id, answers: { q1: { selected: ["A"] } } });
			expect((await first).success).toBe(true);

			// And once the declarer leaves, the session asks the old client the degraded dialog it gets today.
			expect(await declared.request({ type: "release_attachment", sessionId })).toMatchObject({ success: true });
			const degraded = nextDialog(legacy, sessionId);
			ask(legacy, sessionId);
			expect((await degraded).method).toBe("select");
		});
	}, 120_000);

	it("a client command whose id the router once used internally still gets its own reply", async () => {
		await withHost(sessionRuntime, async (host) => {
			const owner = await host.connect();
			await owner.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			const reply = owner.wait(
				(record) => record.type === "response" && record.id === "senpi-internal:capability-rebind",
			);
			owner.send({ id: "senpi-internal:capability-rebind", type: "get_state", sessionId: opened.data?.sessionId });
			expect(await reply).toMatchObject({ success: true, command: "get_state" });
		});
	}, 120_000);

	it("an observer's set_client_info leaves a session it is not attached to degraded", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: a degraded session and a second connection that never attached to it.
			const owner = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;
			const observer = await host.connect();

			// When: only the observer declares `question`.
			const info = await observer.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const dialog = nextDialog(owner, sessionId);
			ask(owner, sessionId);

			// Then: the owner's session still asks through the degraded single dialog.
			expect(info.success).toBe(true);
			expect((await dialog).method).toBe("select");
		});
	}, 120_000);

	it("a declaration the connection-role check refuses changes nothing", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: a connection that declared interactive_user without `question`, then opened a session.
			const owner = await host.connect();
			await owner.request({ type: "set_client_info", width: 80, capabilities: [INTERACTIVE_USER_CAPABILITY] });
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;

			// When: it tries to swap that role for `question`.
			const refused = await owner.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const dialog = nextDialog(owner, sessionId);
			ask(owner, sessionId);

			// Then: the role check refuses first and the session still asks degraded.
			expect(refused).toMatchObject({ success: false, error: expect.stringContaining("connection_role_fixed") });
			expect((await dialog).method).toBe("select");
		});
	}, 120_000);
});
