/**
 * omo-desktop-app#4042: records that need a client capability (`extension_event`, the custom-unsupported notice)
 * reach the attached connections that declared it, and an undeclared one as before. A session subscribes extension
 * events while any attached connection declared `extension_events`. Mirror subscribers are read-only observers
 * and receive every mirrored record unfiltered, by design.
 */
import { describe, expect, it } from "vitest";
import { notified, openShared, RUNTIMES, recordsOf, run, withHost } from "./issue-4042-host-support.ts";

function eventsTagged(records: readonly Record<string, unknown>[], tag: string) {
	return records.filter((record) => (record.data as { tag?: unknown } | undefined)?.tag === tag);
}

describe.each(RUNTIMES)("%s runtime", (sessionRuntime) => {
	it("extension events follow the attached declarations across set changes, without duplicates", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: A and B attached; A declared extension_events, B declared a set without it.
			const a = await host.connect();
			const b = await host.connect();
			await a.request({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
			await b.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const { sessionId } = await openShared(host, a, b);
			const emit = async (tag: string) => {
				const done = notified(a, sessionId, `EMITTED ${tag}`);
				await run(a, sessionId, `/emit-event ${tag}`);
				await done;
				return {
					a: eventsTagged(recordsOf(a, sessionId, "extension_event"), tag).length,
					b: eventsTagged(recordsOf(b, sessionId, "extension_event"), tag).length,
				};
			};

			// Then: A gets each event once, B none; withdrawing unsubscribes; declaring again resubscribes once.
			expect(await emit("first")).toEqual({ a: 1, b: 0 });
			await a.request({ type: "set_client_info", width: 80, capabilities: [] });
			expect(await emit("withdrawn")).toEqual({ a: 0, b: 0 });
			await a.request({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
			expect(await emit("again")).toEqual({ a: 1, b: 0 });
		});
	}, 120_000);

	it("the custom-unsupported notice reaches its declarers and undeclared connections only", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: A declared custom_unsupported, B declared a set without it, C never declared.
			const a = await host.connect();
			const b = await host.connect();
			const c = await host.connect();
			await a.request({ type: "set_client_info", width: 80, capabilities: ["custom_unsupported"] });
			await b.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const { sessionId } = await openShared(host, a, b);
			const sessionPath = (await a.request({ type: "get_state", sessionId })).data?.sessionFile;
			expect(await c.request({ type: "open_session", cwd: host.cwd, sessionPath })).toMatchObject({ success: true });

			// When: an extension renders a custom component.
			const doneOnB = notified(b, sessionId, "CUSTOM one");
			const doneOnC = notified(c, sessionId, "CUSTOM one");
			await run(a, sessionId, "/custom-ui one");
			await Promise.all([doneOnB, doneOnC]);

			// Then: A and C get the notice, B does not.
			const notices = (client: typeof a) =>
				recordsOf(client, sessionId, "extension_ui_request", "custom_unsupported").length;
			expect([notices(a), notices(b), notices(c)]).toEqual([1, 0, 1]);
		});
	}, 120_000);

	it("a mirror subscriber that declared no question still receives the question frame, read-only", async () => {
		await withHost(sessionRuntime, async (host) => {
			// Given: A declared question and opened the session; M declared a set without it and only mirrors.
			const a = await host.connect();
			const m = await host.connect();
			await a.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			await m.request({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
			const opened = await a.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;
			expect(
				await m.request({ type: "subscribe_sessions", sessions: "all", include_workers: false, mirror: "all" }),
			).toMatchObject({ success: true });

			// When: the session asks a question.
			const onA = a.wait((record) => record.type === "extension_ui_request" && record.method === "question");
			const onM = m.wait((record) => record.type === "extension_ui_request" && record.method === "question");
			run(a, sessionId, "/ask-question");

			// Then: the mirror sees the same frame the answerer does.
			expect((await onM).id).toBe((await onA).id);
		});
	}, 120_000);
});
