import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import { CHILD_KILL_EXIT_TIMEOUT_MS, CHILD_STOP_TIMEOUT_MS } from "../../../src/modes/rpc/host-stop-intent.ts";
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
/** Responses the host owes the peer: megabytes, far past any socket buffer, so its queue cannot drain. */
const FLOOD = 3_000;
const STARTED_READING_BYTES = 32 * 1024;

const scratches: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const root of scratches.splice(0)) {
		await reapProcessesUnder(root);
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

/**
 * A peer that selected compact events, opened a session, then stopped reading while the host still owes it megabytes
 * of answers: the host's queue to it can never drain, and a half-closed socket to it never finishes.
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
		process.stdout.write(`5322-MEASURE stalled-peer shutdown ${elapsedMs}ms code=${code} signal=${signal}\n`);
		expect({ code, signal }, "the host exits on its own, not by the escalation").toEqual({ code: 143, signal: null });
		expect(elapsedMs, "within the supervisor's SIGTERM-to-SIGKILL window").toBeLessThan(CHILD_STOP_TIMEOUT_MS);
		expect(host.stderrText(), "the stalled socket was force-closed at the budget").toContain(
			"shutdown budget spent; destroying 1 open connection(s)",
		);
	} finally {
		peer.destroy();
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
		const before = await ensureHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			policy: { idleExitMs: 600_000 },
			hostArgs: [...GENERATION_HOST_ARGS],
			env,
			_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
		});
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
			expect(serving?.instanceId, "the new generation serves the endpoint").not.toBe(before.instanceId);
			expect(oldSocketClosed, "the takeover did not wait for the old stalled socket to close").toBe(false);
		} finally {
			peer.destroy();
		}
	},
	180_000,
);
