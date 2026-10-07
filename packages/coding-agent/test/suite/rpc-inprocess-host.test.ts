import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseArgs, resolveSessionRuntime } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import { listedSessions, MAX_THREADS_PER_SESSION, opened, threadCount } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { startInProcessHost, startWorkerHost } from "./rpc-worker-host-support.ts";

/** Sessions opened on one host: more than double the worker runtime's 20-worker cap. */
const DAEMON_SESSIONS = 45;
/** Idle window for the close-reason cases; eviction fires at twice this. */
const CLOSE_REASON_IDLE_MS = 1_000;
/** Timer-only fakes plus `Date`: the registry's idle clock is `Date.now`. */
const IDLE_CLOCK_FAKES = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;

const scratches: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function rigDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-inprocess-registry-"));
	scratches.push(dir);
	return dir;
}

it("opens more sessions than the worker cap on one in-process registry and reopens by path", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-inprocess-registry-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory({ parsed, cwd, agentDir, appMode: "rpc" }),
		closeGraceMs: 1000,
	});
	let latest: unknown;
	const writer = new SessionEventWriter((line) => {
		latest = JSON.parse(line);
	});
	const router = new SessionCommandRouter(registry, writer, { cwd });
	const firstPath = join(scratch, "original.jsonl");
	try {
		const sessions = [];
		for (let session = 0; session < DAEMON_SESSIONS; session++) {
			const command = { type: "open_session" as const, cwd, ...(session === 0 ? { sessionPath: firstPath } : {}) };
			expect(await router.handle(command)).toBeUndefined();
			await writer.flush();
			sessions.push(opened(latest, session));
		}
		expect(registry.size).toBe(DAEMON_SESSIONS);
		expect(DAEMON_SESSIONS).toBeGreaterThan(SESSION_WORKER_LIMITS.workers);

		expect(listedSessions(await router.handle({ type: "list_sessions" }))).toHaveLength(DAEMON_SESSIONS);

		const first = sessions[0];
		if (!first) throw new Error("No first session");
		expect(await router.handle({ type: "open_session", cwd, sessionPath: firstPath })).toBeUndefined();
		await writer.flush();
		expect(opened(latest, 0)).toMatchObject({ attached: true, sessionId: first.sessionId });
		expect(registry.peek(first.sessionId)?.attachments).toBe(2);

		for (let attachment = 0; attachment < 2; attachment++) {
			await router.handle({ type: "close_session", sessionId: first.sessionId });
			await writer.flush();
		}
		expect(registry.peek(first.sessionId)).toBeUndefined();
		expect(registry.size).toBe(DAEMON_SESSIONS - 1);

		expect(await router.handle({ type: "open_session", cwd, sessionPath: firstPath })).toBeUndefined();
		await writer.flush();
		// Reopen, not attach: the close released the path reservation, so the same file
		// is openable again (a leaked reservation would answer `session_path_in_use`).
		const reopened = opened(latest, 0);
		expect(reopened.attached).toBeUndefined();
		expect(reopened.sessionId).not.toBe(first.sessionId);
		expect(reopened.state.sessionFile).toBe(first.state.sessionFile);
		expect(registry.size).toBe(DAEMON_SESSIONS);
	} finally {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	}
}, 300_000);

it("runs every session of a --listen socket host in the host process", async () => {
	const host = await startInProcessHost();
	try {
		const pid = host.child.pid;
		if (pid === undefined) throw new Error("Host has no pid");
		const client = await host.connect();
		const firstPath = join(host.scratch, "original.jsonl");
		const sessions = [];
		let threadsAfterFirstOpen = 0;
		for (let session = 0; session < DAEMON_SESSIONS; session++) {
			const command = { type: "open_session", cwd: host.cwd, ...(session === 0 ? { sessionPath: firstPath } : {}) };
			sessions.push(opened(await client.request(command), session));
			// Read after the first open: the runtime's thread pool warms up once, and the
			// claim under test is that sessions 2..45 add no thread of their own.
			if (session === 0) threadsAfterFirstOpen = threadCount(pid);
		}
		expect(sessions).toHaveLength(DAEMON_SESSIONS);
		const threadGrowth = threadCount(pid) - threadsAfterFirstOpen;
		process.stderr.write(`in-process host ${pid}: +${threadGrowth} threads across ${DAEMON_SESSIONS - 1} opens\n`);
		expect(threadGrowth).toBeLessThan(MAX_THREADS_PER_SESSION * (DAEMON_SESSIONS - 1));
		expect(listedSessions(await client.request({ type: "list_sessions" }))).toHaveLength(DAEMON_SESSIONS);

		const first = sessions[0];
		if (!first) throw new Error("No first session");
		const attached = await client.request({ type: "open_session", cwd: host.cwd, sessionPath: firstPath });
		expect(opened(attached, 0)).toMatchObject({ attached: true, sessionId: first.sessionId });
		for (let attachment = 0; attachment < 2; attachment++) {
			expect(await client.request({ type: "close_session", sessionId: first.sessionId })).toMatchObject({
				success: true,
			});
		}
		expect(listedSessions(await client.request({ type: "list_sessions" }))).toHaveLength(DAEMON_SESSIONS - 1);

		const reopened = opened(await client.request({ type: "open_session", cwd: host.cwd, sessionPath: firstPath }), 0);
		expect(reopened.attached).toBeUndefined();
		expect(reopened.sessionId).not.toBe(first.sessionId);
		expect(reopened.state.sessionFile).toBe(first.state.sessionFile);
		expect(listedSessions(await client.request({ type: "list_sessions" }))).toHaveLength(DAEMON_SESSIONS);
	} finally {
		await host.dispose();
	}
}, 600_000);

it("keeps the worker runtime and its session cap when --session-runtime worker is selected", async () => {
	const host = await startWorkerHost(undefined, { socket: true, sessionRuntime: "worker" });
	try {
		const pid = host.child.pid;
		if (pid === undefined) throw new Error("Host has no pid");
		const client = await host.connect();
		const before = threadCount(pid);
		for (let session = 0; session < SESSION_WORKER_LIMITS.workers; session++) {
			opened(await client.request({ type: "open_session", cwd: host.cwd }), session);
		}
		process.stderr.write(
			`worker host ${pid}: +${threadCount(pid) - before} threads across ${SESSION_WORKER_LIMITS.workers} opens\n`,
		);
		// The flag selects a runtime; it does not delete the worker runtime's admission bound.
		expect(await client.request({ type: "open_session", cwd: host.cwd })).toMatchObject({
			success: false,
			error: "open_failed: too_many_sessions",
		});
	} finally {
		await host.dispose();
	}
}, 600_000);

it("defaults socket hosts to the in-process runtime and keeps stdio hosts on workers", () => {
	const runtimeOf = (args: string[]) =>
		resolveSessionRuntime(parseArgs(["--mode", "rpc", "--multi-session", ...args]));
	expect(runtimeOf(["--listen", "unix:///tmp/senpi-rpc.sock"])).toBe("in-process");
	expect(runtimeOf(["--listen", "unix://"])).toBe("in-process");
	expect(runtimeOf([])).toBe("worker");
	expect(runtimeOf(["--listen", "stdio://"])).toBe("worker");
	expect(runtimeOf(["--listen", "unix:///tmp/senpi-rpc.sock", "--session-runtime", "worker"])).toBe("worker");
	expect(runtimeOf(["--session-runtime", "in-process"])).toBe("in-process");
	const invalid = parseArgs(["--mode", "rpc", "--session-runtime", "isolate"]);
	expect(invalid.sessionRuntime).toBeUndefined();
	expect(invalid.diagnostics).toEqual([{ type: "error", message: "--session-runtime must be in-process or worker" }]);
});

it("reopens a closed path while the previous session is still tearing down", async () => {
	// Given: a path opened by one connection and attached by a second, then closed by the
	// opener - the session survives on the connection that is still attached.
	const dir = await rigDir();
	await using rig = createInProcessRig(dir);
	const path = join(dir, "reopen.jsonl");
	const session = opened(await rig.open("conn-a", { cwd: dir, sessionPath: path }), 0);
	expect(opened(await rig.open("conn-b", { cwd: dir, sessionPath: path }), 0)).toMatchObject({ attached: true });
	await rig.close("conn-a", session.sessionId);

	// When: the surviving connection drops with the teardown held open, and the path is
	// reopened while that teardown is still in flight.
	rig.teardown.hold();
	const dropped = rig.drop("conn-b");
	await rig.settle();
	expect(await rig.list()).toEqual([expect.objectContaining({ sessionId: session.sessionId, status: "closing" })]);
	const reopening = rig.open("conn-c", { cwd: dir, sessionPath: path });
	await rig.settle();
	rig.teardown.release();
	await dropped;

	// Then: the open waited out the teardown and opened the file fresh, instead of being
	// refused with `session_path_in_use` for a session that was already ending.
	const reopened = opened(await reopening, 0);
	expect(reopened.attached).toBeUndefined();
	expect(reopened.sessionId).not.toBe(session.sessionId);
	expect(reopened.state.sessionFile).toBe(session.state.sessionFile);
	expect(await rig.list()).toEqual([
		expect.objectContaining({ sessionId: reopened.sessionId, status: "open", attachments: 1 }),
	]);
});

it("names client_close on an explicit close_session", async () => {
	// Given: an open session on the in-process registry.
	const dir = await rigDir();
	await using rig = createInProcessRig(dir);
	const session = opened(await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "close.jsonl") }), 0);

	// When: the connection that opened it closes it.
	await rig.close("conn-a", session.sessionId);

	// Then: the handle ended because the client asked, not because the host swept it.
	expect(rig.records()).toContainEqual({
		type: "session_closed",
		sessionId: session.sessionId,
		reason: "client_close",
	});
});

it("names idle_evicted when a non-retained session hits the idle window", async () => {
	// Given: a connected session that was never marked retain-on-disconnect.
	vi.useFakeTimers({ toFake: [...IDLE_CLOCK_FAKES] });
	const dir = await rigDir();
	await using rig = createInProcessRig(dir, { idleEvictionMs: CLOSE_REASON_IDLE_MS });
	const session = opened(await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "idle.jsonl") }), 0);

	// When: the idle window elapses while that session is still listed.
	await vi.advanceTimersByTimeAsync(CLOSE_REASON_IDLE_MS * 2);
	await rig.settle();

	// Then: the host closed it for idleness, and it is gone from the listing.
	expect(rig.records()).toContainEqual({
		type: "session_closed",
		sessionId: session.sessionId,
		reason: "idle_evicted",
	});
	expect(await rig.list()).toEqual([]);
});

it("emits session_parked instead of session_closed when a retained session hits the idle window", async () => {
	// Given: a retained session whose idle window is armed.
	vi.useFakeTimers({ toFake: [...IDLE_CLOCK_FAKES] });
	const dir = await rigDir();
	await using rig = createInProcessRig(dir, { idleEvictionMs: CLOSE_REASON_IDLE_MS });
	const session = opened(
		await rig.open("conn-a", {
			cwd: dir,
			sessionPath: join(dir, "park.jsonl"),
			retain_on_disconnect: true,
		}),
		0,
	);

	// When: the idle window elapses.
	await vi.advanceTimersByTimeAsync(CLOSE_REASON_IDLE_MS * 2);
	await rig.settle();

	// Then: the handle was parked for reopen-by-path, never closed as idle-evicted.
	expect(rig.records()).toContainEqual({
		type: "session_parked",
		sessionId: session.sessionId,
		sessionPath: session.state.sessionFile,
	});
	expect(rig.records().filter((record) => record.type === "session_closed")).toEqual([]);
});

it("names handoff_parked when a drain parks a detached retained session", async () => {
	// Given: a retained session whose only connection has already dropped.
	const dir = await rigDir();
	await using rig = createInProcessRig(dir);
	const session = opened(
		await rig.open("conn-a", {
			cwd: dir,
			sessionPath: join(dir, "drain.jsonl"),
			retain_on_disconnect: true,
		}),
		0,
	);
	await rig.drop("conn-a");

	// When: the host is asked to drain for a generation handoff.
	rig.router.beginDrain();
	await rig.settle();

	// Then: the record names the handoff, so a client reopens by path instead of treating a loss.
	expect(rig.records()).toContainEqual({
		type: "session_closed",
		sessionId: session.sessionId,
		reason: "handoff_parked",
		sessionPath: session.state.sessionFile,
	});
});

it("names host_shutdown when the host process is SIGTERM'd", async () => {
	// Given: a live in-process socket host with one attached session.
	// Force the source CLI: the default helper boots `dist/cli.js`, which would not
	// carry this change until a rebuild.
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startInProcessHost();
	try {
		const client = await host.connect();
		const session = opened(await client.request({ type: "open_session", cwd: host.cwd }), 0);
		const closed = client.wait(
			(record) => record.type === "session_closed" && record.sessionId === session.sessionId,
		);

		// When: the host process receives SIGTERM.
		host.child.kill("SIGTERM");

		// Then: the still-connected client learns the host is exiting, not that the session idled out.
		expect(await closed).toMatchObject({
			type: "session_closed",
			sessionId: session.sessionId,
			reason: "host_shutdown",
		});
	} finally {
		await host.dispose();
	}
}, 120_000);

it("does not park a retained session when the host is shutting down", async () => {
	// Given: a retained session on a live host - the adversarial mix-up is host_shutdown vs park.
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startInProcessHost();
	try {
		const client = await host.connect();
		const session = opened(
			await client.request({
				type: "open_session",
				cwd: host.cwd,
				retain_on_disconnect: true,
			}),
			0,
		);
		const closed = client.wait(
			(record) => record.type === "session_closed" && record.sessionId === session.sessionId,
		);

		// When: the host is SIGTERM'd with that retained session still attached.
		host.child.kill("SIGTERM");

		// Then: the host going away is a close named host_shutdown, never a park the client would reopen here.
		expect(await closed).toMatchObject({ type: "session_closed", reason: "host_shutdown" });
		expect(client.records.some((record) => record.type === "session_parked")).toBe(false);
	} finally {
		await host.dispose();
	}
}, 120_000);
