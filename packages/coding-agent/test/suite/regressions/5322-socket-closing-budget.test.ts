import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import { HOST_SHUTDOWN_BUDGET_MS } from "../../../src/modes/rpc/host-shutdown-connections.ts";
import { CHILD_KILL_EXIT_TIMEOUT_MS } from "../../../src/modes/rpc/host-stop-intent.ts";
import {
	GENERATION_HOST_ARGS,
	generationEnv,
	generationScratch,
	supervisorLaunch,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { reapProcessesUnder } from "../../helpers/spawned-host-reaper.ts";
import { startInProcessHost } from "../rpc-worker-host-support.ts";

// RULING-124 (#5322): the half-close grace that flushes `socket_closing` never extends a host shutdown past its budget
// (the supervisor's SIGTERM-to-SIGKILL window), and a handoff never waits on the old host's sockets.

const FLAG = { SENPI_ENGINE_SOCKET_COMPACT_UPDATES: "1" };
const PAIR = ["compact_message_updates_v1", "event_resync"];
/** Responses the host owes the peer: about a megabyte, far past any socket buffer, so its queue cannot drain. */
const FLOOD = 500;
const STARTED_READING_BYTES = 32 * 1024;
/** How late the host's own budget timer may fire on a loaded machine; far below the 3 s exit reserve it protects. */
const TIMER_SLACK_MS = 500;

const scratches: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const root of scratches.splice(0)) {
		await reapProcessesUnder(root);
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

/**
 * A peer that selected compact events, opened a session, then stopped reading while the host still owes it about a
 * megabyte of answers: the host's queue to it can never drain, and a half-closed socket to it never finishes.
 */
async function stalledCompactPeer(socketPath: string, cwd: string): Promise<Socket> {
	const socket = createConnection(socketPath);
	socket.on("error", () => {});
	await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
	let text = "";
	let received = 0;
	const opened = Promise.withResolvers<void>();
	const answering = Promise.withResolvers<void>();
	socket.on("data", (chunk: Buffer) => {
		text += chunk.toString("utf8");
		received += chunk.length;
		if (text.includes('"id":"select"') && text.includes('"id":"open"')) opened.resolve();
		if (received >= STARTED_READING_BYTES && text.includes('"id":"p-0"')) answering.resolve();
	});
	const send = (command: Record<string, unknown>) => socket.write(`${JSON.stringify(command)}\n`);
	send({ id: "select", type: "set_client_info", width: 100, capabilities: PAIR });
	send({ id: "open", type: "open_session", cwd, admissionId: "stalled" });
	await opened.promise;
	expect(text).not.toContain('"success":false');
	for (let index = 0; index < FLOOD; index++) send({ id: `p-${index}`, type: "get_protocol_info" });
	await answering.promise;
	socket.pause();
	return socket;
}

/** A compact peer that keeps reading: its records, and how and when (since `since`) the host closed its socket. */
async function readingCompactPeer(socketPath: string, cwd: string) {
	const socket = createConnection(socketPath);
	socket.on("error", () => {});
	await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
	let text = "";
	const opened = Promise.withResolvers<void>();
	socket.on("data", (chunk: Buffer) => {
		text += chunk.toString("utf8");
		if (text.includes('"id":"select"') && text.includes('"id":"open"')) opened.resolve();
	});
	const ended = once(socket, "end").then(() => "end" as const);
	const reset = once(socket, "error").then(() => "error" as const);
	const send = (command: Record<string, unknown>) => socket.write(`${JSON.stringify(command)}\n`);
	send({ id: "select", type: "set_client_info", width: 100, capabilities: PAIR });
	send({ id: "open", type: "open_session", cwd, admissionId: "healthy" });
	await opened.promise;
	return {
		socket,
		records: () => text.split("\n").flatMap((line) => (line ? [JSON.parse(line) as Record<string, unknown>] : [])),
		/** Whether the host ended the socket (FIN after its records) or reset it, and when, in ms since `since`. */
		closed: (since: number) => Promise.race([ended, reset]).then((how) => ({ how, atMs: performance.now() - since })),
	};
}

it("RULING-124 a compact peer that never reads cannot hold a SIGTERM'd host past its shutdown budget", async () => {
	// Force the source CLI: the default helper boots `dist/cli.js`, which would not carry this change until a rebuild.
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startInProcessHost(undefined, FLAG);
	const peer = await stalledCompactPeer(host.socketPath, host.cwd);
	try {
		const exited = once(host.child, "exit");
		const signalledAt = performance.now();
		host.child.kill("SIGTERM");
		// The supervisor's escalation, so a host that ignores its budget fails this case instead of hanging it.
		const escalation = setTimeout(() => host.child.kill("SIGKILL"), CHILD_KILL_EXIT_TIMEOUT_MS);
		const [code, signal] = await exited;
		clearTimeout(escalation);
		const elapsedMs = Math.round(performance.now() - signalledAt);
		const forced = /shutdown budget spent after (\d+) ms; destroying 1 open connection\(s\)/.exec(host.stderrText());
		process.stdout.write(
			`5322-MEASURE stalled-peer shutdown ${elapsedMs}ms code=${code} signal=${signal} forced=${forced?.[1]}ms\n`,
		);
		expect({ code, signal }, "the host exits on its own, not by the escalation").toEqual({ code: 143, signal: null });
		// The host's own clock, from its SIGTERM handler: the stalled socket was destroyed at the shutdown budget, inside the
		// supervisor's stop window, never after the 5 s half-close grace or the unbounded queue drain. The wall-clock exit
		// above adds process teardown, which on a loaded machine exceeds the window even for a host with no peer at all.
		expect(forced, "the stalled socket was force-closed at the budget").not.toBeNull();
		expect(Number(forced?.[1]), "at the shutdown budget, before the half-close grace").toBeLessThanOrEqual(
			HOST_SHUTDOWN_BUDGET_MS + TIMER_SLACK_MS,
		);
	} finally {
		peer.destroy();
		await host.dispose();
	}
}, 120_000);

it("RULING-124 a stalled peer cannot spend a healthy compact peer's shutdown drain: it gets socket_closing and a clean close", async () => {
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startInProcessHost(undefined, FLAG);
	const healthy = await readingCompactPeer(host.socketPath, host.cwd);
	const stalled = await stalledCompactPeer(host.socketPath, host.cwd);
	try {
		const exited = once(host.child, "exit");
		const signalledAt = performance.now();
		host.child.kill("SIGTERM");
		const closed = await healthy.closed(signalledAt);
		const escalation = setTimeout(() => host.child.kill("SIGKILL"), CHILD_KILL_EXIT_TIMEOUT_MS);
		await exited;
		clearTimeout(escalation);
		const forced = /shutdown budget spent after (\d+) ms; destroying 1 open connection\(s\)/.exec(host.stderrText());
		process.stdout.write(
			`5322-MEASURE healthy peer closed ${Math.round(closed.atMs)}ms (${closed.how}) forced=${forced?.[1]}ms\n`,
		);
		expect(healthy.records().at(-1)).toEqual({ type: "socket_closing", code: "host_shutdown", retryable: true });
		expect(closed.how, "a graceful half-close, not a reset at the forced destroy").toBe("end");
		expect(forced, "only the stalled socket was force-closed").not.toBeNull();
		// The healthy peer's drain and close did not wait for the stalled peer's: it closed long before the budget ran out.
		expect(closed.atMs).toBeLessThan(Number(forced?.[1]) - TIMER_SLACK_MS);
	} finally {
		healthy.socket.destroy();
		stalled.destroy();
		await host.dispose();
	}
}, 120_000);

it.skipIf(process.platform === "win32")(
	"RULING-124 a handoff takes over while the old host's stalled compact socket is still open",
	async () => {
		const qa = generationScratch("5322");
		scratches.push(qa.root);
		writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
		const env = { ...generationEnv(qa), ...FLAG };
		await ensureHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			policy: { idleExitMs: 600_000 },
			hostArgs: [...GENERATION_HOST_ARGS],
			env,
			_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
		});
		const before = await probeHost({ socket: qa.socket });
		const peer = await stalledCompactPeer(qa.socket, qa.cwd);
		let oldSocketClosed = false;
		peer.once("close", () => {
			oldSocketClosed = true;
		});
		try {
			const startedAt = performance.now();
			const result = await handoffHost({
				socket: qa.socket,
				agentDir: qa.agentDir,
				hostArgs: [...GENERATION_HOST_ARGS],
				env,
				_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
			});
			const elapsedMs = Math.round(performance.now() - startedAt);
			process.stdout.write(`5322-MEASURE handoff with stalled peer ${elapsedMs}ms\n`);
			expect(result).toMatchObject({ action: "handoff", generation: 1 });
			const serving = await probeHost({ socket: qa.socket });
			expect(serving?.instanceId, "the new generation serves the endpoint").not.toBe(before?.instanceId);
			expect(oldSocketClosed, "the takeover did not wait for the old stalled socket to close").toBe(false);
		} finally {
			peer.destroy();
		}
	},
	180_000,
);
