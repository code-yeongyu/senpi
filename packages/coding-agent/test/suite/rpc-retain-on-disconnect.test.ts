import { afterEach, expect, it, vi } from "vitest";
import { retainHost } from "./rpc-retain-on-disconnect-support.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";
import { reservationPhase } from "./rpc-worker-reservation-support.ts";

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	const { EventEmitter } = await import("node:events");
	return {
		...actual,
		Worker: class extends EventEmitter {
			postMessage(): void {}
			terminate(): Promise<number> {
				return Promise.resolve(0);
			}
		},
	};
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("keeps a retained session listed and re-attachable after its only connection drops", async () => {
	// Given: a retained idle session owned by exactly one connection.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	await using host = await retainHost({ idleEvictionMs: 60_000 });
	const opened = await host.open("conn-a", { cwd: host.cwd, retain_on_disconnect: true });
	const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId;
	const sessionPath = (opened?.data as { state?: { sessionFile?: string } } | undefined)?.state?.sessionFile;
	expect(sessionId).toBeDefined();
	expect(sessionPath).toBeDefined();

	// When: that connection drops and two seconds of host time pass.
	await host.drop("conn-a");
	host.clock.now += 2_000;
	await vi.advanceTimersByTimeAsync(2_000);

	// Then: the session is still listed, detached, and a later open attaches to it.
	expect(await host.list()).toEqual([expect.objectContaining({ sessionId, status: "open", attachments: 0 })]);
	const reattached = await host.open("conn-b", { cwd: host.cwd, sessionPath });
	expect(reattached?.data).toMatchObject({ sessionId, attached: true });
	expect(await host.list()).toEqual([expect.objectContaining({ sessionId, attachments: 1 })]);
});

it("runs a retained session's in-flight turn to settlement after the drop", async () => {
	// Given: a retained session whose only connection drops mid-turn.
	await using host = await retainHost();
	const opened = await host.open("conn-a", { cwd: host.cwd, retain_on_disconnect: true });
	const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId ?? "";
	await host.client(sessionId).activity({ busy: true, streaming: true });
	await host.drop("conn-a");

	// When: the turn settles after the drop.
	await host.client(sessionId).output({ type: "agent_settled" });
	await host.client(sessionId).activity({ busy: false, streaming: false }, true);
	await host.settle();

	// Then: the turn's settlement was published and the session outlived it.
	expect(host.records.filter((record) => record.type === "agent_settled" && record.sessionId === sessionId)).toEqual([
		{ type: "agent_settled", sessionId },
	]);
	expect(host.posted.filter(({ message }) => message.type === "close")).toEqual([]);
	expect(await host.list()).toEqual([expect.objectContaining({ sessionId, status: "open", attachments: 0 })]);
});

it("closes a session opened without the flag when its connection drops", async () => {
	// Given: a session opened with today's defaults.
	await using host = await retainHost();
	const opened = await host.open("conn-a", { cwd: host.cwd });
	const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId ?? "";
	expect(await host.list()).toEqual([expect.objectContaining({ sessionId, status: "open", attachments: 1 })]);

	// When: its only connection drops.
	await host.drop("conn-a");

	// Then: it is torn down exactly as before this flag existed.
	expect(host.posted.filter(({ message }) => message.type === "close")).toHaveLength(1);
	expect(await host.list()).toEqual([]);
});

it("closes a retained detached session on an explicit close_session", async () => {
	// Given: a retained session that survived its owner's drop and was re-attached.
	await using host = await retainHost();
	const opened = await host.open("conn-a", { cwd: host.cwd, retain_on_disconnect: true });
	const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId ?? "";
	const sessionPath = (opened?.data as { state?: { sessionFile?: string } } | undefined)?.state?.sessionFile;
	await host.drop("conn-a");
	expect((await host.open("conn-b", { cwd: host.cwd, sessionPath }))?.data).toMatchObject({ attached: true });

	// When: the attached connection closes it explicitly.
	await host.close("conn-b", sessionId);

	// Then: retention never outranks an explicit close.
	expect(await host.list()).toEqual([]);
	expect(host.records).toContainEqual(expect.objectContaining({ type: "session_closed", sessionId }));
});

it("advertises retain_on_disconnect in get_protocol_info", async () => {
	await using host = await retainHost();
	const response = await host.router.handle({ type: "get_protocol_info", id: "probe" });
	const data = (response as { data?: { capabilities?: string[] } } | undefined)?.data;
	expect(data?.capabilities).toContain("retain_on_disconnect");
	expect(data?.capabilities).toContain("multi_session");
});

// The drop semantics above are pinned deterministically on the router; this one
// pins the wire surface on a REAL socket host and real session worker: the flag
// is accepted, the capability is advertised, the attachment count is published,
// and an explicit close still closes a retained session.
it("advertises the capability and accepts the flag on a real socket host", async () => {
	const host = await startWorkerHost(undefined, { socket: true });
	try {
		const client = await host.connect();
		const protocol = await client.request({ type: "get_protocol_info" });
		expect(protocol.data?.capabilities).toContain("retain_on_disconnect");
		const opened = await client.request({ type: "open_session", cwd: host.cwd, retain_on_disconnect: true });
		expect(opened.success).toBe(true);
		const sessionId = opened.data?.sessionId;
		expect((await client.request({ type: "list_sessions" })).data?.sessions).toEqual([
			expect.objectContaining({ sessionId, status: "open", attachments: 1 }),
		]);
		expect((await client.request({ type: "close_session", sessionId })).success).toBe(true);
		expect((await client.request({ type: "list_sessions" })).data?.sessions).toEqual([]);
	} finally {
		await host.dispose();
	}
}, 60_000);

it("parks a retained detached session at the idle window and reopens it by path", async () => {
	// Given: a retained session detached from every connection.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	await using host = await retainHost({ idleEvictionMs: 1_000 });
	const opened = await host.open("conn-a", { cwd: host.cwd, retain_on_disconnect: true });
	const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId ?? "";
	const sessionPath = (opened?.data as { state?: { sessionFile?: string } } | undefined)?.state?.sessionFile;
	await host.drop("conn-a");

	// When: the idle-eviction window elapses with the session detached.
	host.clock.now += 1_500;
	await vi.advanceTimersByTimeAsync(1_500);

	// Then: retention does not exempt it from eviction, and its path reopens.
	expect(await host.list()).toEqual([]);
	const reopened = await host.open("conn-b", { cwd: host.cwd, sessionPath });
	expect((reopened?.data as { sessionId?: string; attached?: boolean } | undefined)?.attached).toBeUndefined();
	expect((reopened?.data as { sessionId?: string } | undefined)?.sessionId).not.toBe(sessionId);
});

it.each([
	{ kind: "interactive", retain: true },
	{ kind: "interactive", retain: false },
	{ kind: "worker", retain: true },
	{ kind: "worker", retain: false },
] as const)(
	"keeps an attached $kind isolate alive while a client polls get_state (retained: $retain)",
	async ({ kind, retain }) => {
		// Given: an attached, idle worker isolate whose only traffic is status polling.
		await using host = await retainHost({ idleEvictionMs: 1_000 });
		await host.open("owner", { cwd: host.cwd, kind, retain_on_disconnect: retain });
		const [row] = await host.list();
		if (!row) throw new Error("Session did not open");
		const entry = host.registry.peek(row.sessionId);
		if (!entry) throw new Error("Session did not open");
		host.clock.now = 999;

		// When: the client polls it just before the deadline, then the sweep runs.
		await host.writer.withConnection("owner", () =>
			host.router.handle({ id: "poll", type: "get_state", sessionId: row.sessionId }),
		);
		host.clock.now = 1_000;
		host.router.sweepIdleSessions();
		await host.writer.withConnection("owner", () =>
			host.router.handle({ id: "after", type: "get_state", sessionId: row.sessionId }),
		);

		// Then: no park/evict event and the isolate still lists open and attached.
		expect(entry.state).toBe("open");
		const lifecycle = host.records.filter(
			(record) =>
				record.sessionId === row.sessionId &&
				(record.type === "session_parked" || record.type === "session_closed"),
		);
		expect(lifecycle).toEqual([]);
		expect(await host.list()).toEqual([expect.objectContaining({ sessionId: row.sessionId, attachments: 1 })]);
		expect(host.posted.filter(({ message }) => message.type === "command")).toHaveLength(2);
	},
);

it.each(["get_state", "memory_report"])(
	"does not renew a detached worker isolate's idle window for %s",
	async (command) => {
		// Given: an idle retained worker isolate nobody is attached to, near its eviction deadline.
		const published = Promise.withResolvers<void>();
		let awaitedSession: string | undefined;
		await using host = await retainHost({
			idleEvictionMs: 1_000,
			onRecord: (record) => {
				if (
					record.sessionId === awaitedSession &&
					(record.type === "session_parked" || record.type === "session_closed")
				)
					published.resolve();
			},
		});
		await host.open("owner", { cwd: host.cwd, retain_on_disconnect: true });
		const [row] = await host.list();
		if (!row) throw new Error("Session did not open");
		const entry = host.registry.peek(row.sessionId);
		if (!entry) throw new Error("Session did not open");
		await host.drop("owner");
		host.clock.now = 999;
		awaitedSession = row.sessionId;

		// When: a detached observation is routed just before the deadline.
		host.registry.getForCommand(row.sessionId, command);
		host.clock.now = 1_000;
		host.router.sweepIdleSessions();

		// Then: the observation has not extended the isolate's lifetime, and the close event names it.
		expect(entry.state).toBe("closing");
		await entry.closeCompletion;
		expect(await host.list()).toEqual([]);
		await reservationPhase("detached-worker-lifecycle-published", published.promise);
		const lifecycle = host.records.filter(
			(record) =>
				record.sessionId === row.sessionId &&
				(record.type === "session_parked" || record.type === "session_closed"),
		);
		expect(lifecycle.length).toBeGreaterThan(0);
	},
);
