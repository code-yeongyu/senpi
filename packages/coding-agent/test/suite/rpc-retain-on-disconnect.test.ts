import type { EventEmitter } from "node:events";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { buildRpcSessionState } from "../../src/modes/rpc/connection-handler.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import type { HostToSessionWorker, WorkerSnapshot } from "../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";
import { createHarness } from "./harness.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

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

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };
type ListedSession = { sessionId: string; status: string; sessionPath?: string; attachments: number };

/** Fields the host accepts on `open_session`, including the retention flag under test. */
interface OpenFields {
	cwd?: string;
	sessionPath?: string;
	retain_on_disconnect?: boolean;
	kind?: "interactive" | "worker";
}

/**
 * One shared multi-session host: the real router, registry, writer and worker
 * client, with only the worker THREAD replaced. Every lifecycle decision under
 * test (attachment refcount, release on connection drop, eviction sweep) runs
 * its production code path; the fake worker answers the same protocol a real
 * session worker answers and exits when the host asks it to close.
 */
async function retainHost(options: { idleEvictionMs?: number } = {}) {
	const harness = await createHarness();
	const baseState = buildRpcSessionState(harness.session);
	const clock = { now: 0 };
	const paths = new Map<EventEmitter, string>();
	const posted: Array<{ worker: EventEmitter; message: HostToSessionWorker }> = [];
	let serial = 0;
	const snapshotFor = (path: string, activity?: Partial<WorkerSnapshot>): WorkerSnapshot => ({
		state: { ...baseState, sessionId: `durable-${path}`, sessionFile: path },
		sessionPath: path,
		liveSessionPaths: [path],
		busy: false,
		streaming: false,
		...activity,
	});
	vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
		this: EventEmitter,
		message: HostToSessionWorker,
	) {
		posted.push({ worker: this, message });
		switch (message.type) {
			case "prepare": {
				const path = message.profile.sessionPath ?? join(harness.tempDir, `session-${++serial}.jsonl`);
				paths.set(this, path);
				queueMicrotask(() =>
					this.emit("message", { type: "prepared", request: message.request, sessionPath: path }),
				);
				break;
			}
			case "commit": {
				const path = paths.get(this) ?? "";
				queueMicrotask(() =>
					this.emit("message", { type: "ready", request: message.request, snapshot: snapshotFor(path) }),
				);
				break;
			}
			case "bind":
			case "command":
			case "prompt_surface":
			case "browser_engine":
			case "permission_preset":
				queueMicrotask(() => this.emit("message", { type: "result", request: message.request }));
				break;
			case "close":
				// A real session worker exits on close; the host releases ownership on that exit.
				queueMicrotask(() => this.emit("exit", 0));
				break;
			case "cancel_ui":
				break;
			default: {
				const exhaustive: never = message;
				throw new Error(`Unexpected message ${exhaustive}`);
			}
		}
	});
	// Every destination the host writes to, in write order: the stdio lane plus
	// each registered client connection.
	const records: WireRecord[] = [];
	const collect = (line: string): void => void records.push(JSON.parse(line) as WireRecord);
	const writer = new SessionEventWriter(collect);
	const registered = new Set<string>();
	const connect = (connection: string): string => {
		if (registered.has(connection)) return connection;
		writer.registerConnection(connection, { writeRaw: collect, waitForBackpressure: async () => {} });
		registered.add(connection);
		return connection;
	};
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc"]),
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			appMode: "rpc",
		},
		closeGraceMs: 100,
		now: () => clock.now,
	});
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd: harness.tempDir },
		undefined,
		{},
		{ now: () => clock.now, idleEvictionMs: options.idleEvictionMs },
	);
	let requests = 0;
	/** Drains the host's microtask-driven lifecycle chains, then its record queues. */
	const settle = async (): Promise<void> => {
		for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
		await writer.flush();
	};
	return {
		registry,
		router,
		writer,
		records,
		posted,
		clock,
		cwd: harness.tempDir,
		settle,
		async open(connection: string, fields: OpenFields): Promise<WireRecord | undefined> {
			const id = `open-${++requests}`;
			const failure = await writer.withConnection(connect(connection), () =>
				router.handle({ type: "open_session", id, ...fields }),
			);
			await settle();
			return (failure as WireRecord | undefined) ?? records.find((record) => record.id === id);
		},
		async close(connection: string, sessionId: string): Promise<void> {
			await writer.withConnection(connection, () =>
				router.handle({ type: "close_session", id: `close-${++requests}`, sessionId }),
			);
			await settle();
		},
		/** The socket host's own drop order: unregister the transport, then release its sessions. */
		async drop(connection: string): Promise<void> {
			writer.unregisterConnection(connection);
			registered.delete(connection);
			await router.releaseConnection(connection);
			await settle();
		},
		async list(): Promise<ListedSession[]> {
			const response = await router.handle({
				type: "list_sessions",
				id: `list-${++requests}`,
				include_workers: true,
			});
			return (response as { data?: { sessions?: ListedSession[] } } | undefined)?.data?.sessions ?? [];
		},
		/** The live worker client of an open session, for producing worker-side traffic. */
		client(sessionId: string) {
			const client = registry.peek(sessionId)?.worker;
			if (!client) throw new Error(`Expected a worker client for ${sessionId}`);
			const path = client.snapshot?.sessionPath ?? "";
			return {
				activity(activity: Partial<WorkerSnapshot>, settled?: boolean) {
					client.worker.emit("message", {
						type: "snapshot",
						snapshot: snapshotFor(path, activity),
						signal: new SharedArrayBuffer(8),
						...(settled ? { settled: true } : {}),
					});
				},
				output(record: object) {
					client.worker.emit("message", {
						type: "output",
						record,
						signal: new SharedArrayBuffer(8),
						activity: { busy: false, streaming: false },
					});
				},
			};
		},
		async [Symbol.asyncDispose]() {
			await router.dispose();
			harness.cleanup();
		},
	};
}

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
	host.client(sessionId).activity({ busy: true, streaming: true });
	await host.drop("conn-a");

	// When: the turn settles after the drop.
	host.client(sessionId).output({ type: "agent_settled" });
	host.client(sessionId).activity({ busy: false, streaming: false }, true);
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
		await using host = await retainHost({ idleEvictionMs: 1_000 });
		await host.open("owner", { cwd: host.cwd, retain_on_disconnect: true });
		const [row] = await host.list();
		if (!row) throw new Error("Session did not open");
		const entry = host.registry.peek(row.sessionId);
		if (!entry) throw new Error("Session did not open");
		await host.drop("owner");
		host.clock.now = 999;

		// When: a detached observation is routed just before the deadline.
		host.registry.getForCommand(row.sessionId, command);
		host.clock.now = 1_000;
		host.router.sweepIdleSessions();

		// Then: the observation has not extended the isolate's lifetime, and the close event names it.
		expect(entry.state).toBe("closing");
		await entry.closeCompletion;
		expect(await host.list()).toEqual([]);
		const lifecycle = host.records.filter(
			(record) =>
				record.sessionId === row.sessionId &&
				(record.type === "session_parked" || record.type === "session_closed"),
		);
		expect(lifecycle.length).toBeGreaterThan(0);
	},
);
