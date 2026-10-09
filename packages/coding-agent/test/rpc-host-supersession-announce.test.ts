import { realpathSync, watch } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, ensureHost } from "../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { signalGeneration } from "../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	generationEnv,
	generationScratch,
	HeldAnthropicModel,
	JsonlPeer,
	openedSessionId,
	processAlive,
	reapProcessesUnder,
	supervisorLaunch,
	waitForPidGone,
} from "./helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 120_000);

async function rig(options: { held?: HeldAnthropicModel; monitor?: boolean; graceMs?: number; runtime?: string } = {}) {
	const qa = generationScratch("announce");
	const peers: JsonlPeer[] = [];
	cleanups.push(async () => {
		for (const peer of peers) peer.destroy();
		await reapProcessesUnder(qa.root);
		if (options.held) {
			options.held.release();
			await options.held.close();
		}
		await rm(qa.root, { recursive: true, force: true });
	});
	writeRpcModelsJson(qa.agentDir, options.held?.origin ?? "http://127.0.0.1:1");
	const hostArgs: string[] = [...GENERATION_HOST_ARGS, "--session-runtime", options.runtime ?? "in-process"];
	if (options.monitor) {
		const extension = join(qa.root, "monitor.ts");
		await writeFile(
			extension,
			`import { writeFileSync } from "node:fs";
		 export default function (pi) {
			pi.on("session_start", () => {
				pi.events.emit("wake_source_state", { source: "handoff-test-monitor", activeCount: 1 });
				writeFileSync(${JSON.stringify(join(qa.root, "monitor-ready"))}, "1");
			});
		}`,
		);
		hostArgs.push("--extension", extension);
	}
	const env = { ...generationEnv(qa), SENPI_RPC_HANDOFF_GRACE_MS: String(options.graceMs ?? 600_000) };
	const launch = {
		socket: qa.socket,
		agentDir: qa.agentDir,
		hostArgs,
		env,
		_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
	};
	const host = await ensureHost({ ...launch, policy: { idleExitMs: 600_000 } });
	const identity = await probeHost({ socket: qa.socket });
	const connect = async () => {
		const peer = await JsonlPeer.connect(qa.socket);
		peers.push(peer);
		return peer;
	};
	const client = await connect();
	const sessionPath = join(qa.sessionDir, "session.jsonl");
	// The host reserves and reports session files by CANONICAL path, so on macOS a scratch dir under
	// /var/... comes back as /private/var/.... Open with the raw path (that canonicalization is part
	// of what these tests cover) and compare terminal records against the canonical one.
	const canonicalSessionPath = join(realpathSync(qa.sessionDir), "session.jsonl");
	const sessionId = openedSessionId(
		await client.request({ id: "open", type: "open_session", cwd: qa.cwd, sessionPath }),
	);
	if (options.monitor) expect(await readFile(join(qa.root, "monitor-ready"), "utf8")).toBe("1");
	return {
		qa,
		host,
		identity,
		client,
		sessionId,
		sessionPath,
		canonicalSessionPath,
		connect,
		takeover: () => handoffHost(launch),
		release: () => options.held?.release(),
		drain: () => expect(signalGeneration(host.pid, "SIGUSR1")).toBe(true),
	};
}

/** Observe the supervisor's actual grace-expiry transition, not a guessed scheduling delay. */
async function logSignal(path: string, text: string): Promise<{ done: Promise<void>; cancel: () => void }> {
	let resolve!: () => void;
	let reject!: (cause: unknown) => void;
	const done = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	const check = async () => {
		if ((await readFile(path, "utf8")).includes(text)) resolve();
	};
	const watcher = watch(path, () => {
		void check().catch(reject);
	});
	const timer = setTimeout(() => reject(new Error("supervisor did not report grace expiry")), 20_000);
	const cancel = () => {
		watcher.close();
		clearTimeout(timer);
	};
	void done.then(cancel, cancel);
	await check();
	return { done, cancel };
}

describe.skipIf(process.platform === "win32")("attached generation supersession", () => {
	it("announces then parks an idle attached session, closes its connection and exits", async () => {
		const r = await rig();
		const observer = await r.connect();
		const announcements = Promise.all([
			r.client.waitFor((e) => e.type === "host_superseded", 10_000),
			observer.waitFor((e) => e.type === "host_superseded", 10_000),
		]);
		r.drain();
		const [announcement] = await announcements;
		expect(announcement).toMatchObject({ instanceId: r.identity?.instanceId, generation: 0, successor: null });
		r.client.send({ id: "racing-state", type: "get_state", sessionId: r.sessionId });
		await r.client.waitForClose(20_000);
		expect(r.client.messages.some((e) => e.error === "unknown_session")).toBe(false);
		const lifecycle = r.client.messages.filter((e) => ["host_superseded", "session_closed"].includes(String(e.type)));
		expect(lifecycle.map((e) => e.type)).toEqual(["host_superseded", "session_closed"]);
		expect(lifecycle[1]).toMatchObject({
			sessionId: r.sessionId,
			reason: "handoff_parked",
			sessionPath: r.canonicalSessionPath,
		});
		expect(await waitForPidGone(r.host.pid, 20_000)).toBe(true);
	}, 120_000);

	it.each(["in-process", "worker"])(
		"parks a monitor-only attached session on %s without waiting for its durable wake source",
		async (runtime) => {
			const r = await rig({ monitor: true, runtime });
			const announced = r.client.waitFor((e) => e.type === "host_superseded", 10_000);
			r.drain();
			await announced;
			await r.client.waitForClose(20_000);
			expect(r.client.messages).toContainEqual(
				expect.objectContaining({
					type: "session_closed",
					reason: "handoff_parked",
					sessionPath: r.canonicalSessionPath,
				}),
			);
			expect(await waitForPidGone(r.host.pid, 20_000)).toBe(true);
		},
		120_000,
	);

	it("keeps a turn alive past grace, serves old-connection commands, then parks at settle", async () => {
		const r = await rig({ held: await HeldAnthropicModel.start(), graceMs: 50 });
		const started = r.client.waitFor((e) => e.type === "agent_start" && e.sessionId === r.sessionId);
		await r.client.request({ id: "prompt", type: "prompt", sessionId: r.sessionId, message: "hold" });
		await started;
		const paths = createHostDaemonPaths({ socket: r.qa.socket, agentDir: r.qa.agentDir });
		const expiry = await logSignal(paths.stderrLog, '"event":"handoff_grace_expired"');
		try {
			const announced = r.client.waitFor((e) => e.type === "host_superseded", 10_000);
			r.drain();
			await announced;
			await expiry.done;
			expect(processAlive(r.host.pid)).toBe(true);
			expect(r.client.messages.some((e) => e.type === "session_closed")).toBe(false);
			expect(await r.client.request({ id: "state", type: "get_state", sessionId: r.sessionId })).toMatchObject({
				success: true,
			});
			const settled = r.client.waitFor((e) => e.type === "agent_settled" && e.sessionId === r.sessionId);
			// The held fixture is released only after the measured grace expiry.
			// Cleanup owns the model; release here drives the actual streaming completion.
			r.release();
			await settled;
			await r.client.waitForClose(20_000);
			const types = r.client.messages.map((e) => e.type);
			expect(types.indexOf("session_closed")).toBeGreaterThan(types.indexOf("agent_settled"));
			expect(r.client.messages.some((e) => e.error === "unknown_session")).toBe(false);
			expect(await waitForPidGone(r.host.pid, 20_000)).toBe(true);
		} finally {
			expiry.cancel();
		}
	}, 120_000);

	it("announces once per connection when the drain is requested again", async () => {
		// A re-entered drain (grace expiry, a second SIGUSR1, or a supersession watch firing after the
		// signal) must rescan for parkable sessions WITHOUT announcing twice: a client that reacted to
		// the first record would otherwise see the handoff start over.
		const r = await rig({ held: await HeldAnthropicModel.start() });
		const started = r.client.waitFor((e) => e.type === "agent_start" && e.sessionId === r.sessionId);
		await r.client.request({ id: "prompt", type: "prompt", sessionId: r.sessionId, message: "hold" });
		await started;
		const observer = await r.connect();
		const announced = Promise.all([
			r.client.waitFor((e) => e.type === "host_superseded", 10_000),
			observer.waitFor((e) => e.type === "host_superseded", 10_000),
		]);
		r.drain();
		await announced;
		// The held turn keeps the generation alive, so the second request lands on the same host.
		expect(processAlive(r.host.pid)).toBe(true);
		r.drain();
		// A served round-trip after the second signal is the barrier: the host processed it and is
		// still serving the old connection rather than answering unknown_session.
		expect(await r.client.request({ id: "after-redrain", type: "get_state", sessionId: r.sessionId })).toMatchObject({
			success: true,
		});
		const settled = r.client.waitFor((e) => e.type === "agent_settled" && e.sessionId === r.sessionId);
		r.release();
		await settled;
		await r.client.waitForClose(20_000);
		for (const peer of [r.client, observer]) {
			expect(peer.messages.filter((e) => e.type === "host_superseded")).toHaveLength(1);
		}
		expect(r.client.messages.some((e) => e.error === "unknown_session")).toBe(false);
		expect(await waitForPidGone(r.host.pid, 20_000)).toBe(true);
	}, 120_000);

	it("announces when the socket is replaced without a drain signal", async () => {
		const r = await rig();
		const intruder = createServer((socket) => socket.end());
		const socket = join(r.qa.root, "replacement.sock");
		await new Promise<void>((resolve) => intruder.listen(socket, resolve));
		cleanups.push(() => new Promise<void>((resolve) => intruder.close(() => resolve())));
		const announced = r.client.waitFor((e) => e.type === "host_superseded", 10_000);
		await rename(socket, r.qa.socket);
		expect(await announced).toMatchObject({ successor: { socket: r.qa.socket } });
		await r.client.waitForClose(20_000);
		expect(await waitForPidGone(r.host.pid, 20_000)).toBe(true);
	}, 120_000);

	it("does not close a shared connection while its other session is mid-turn", async () => {
		const r = await rig({ held: await HeldAnthropicModel.start() });
		const active = openedSessionId(
			await r.client.request({ id: "open-active", type: "open_session", cwd: r.qa.cwd }),
		);
		const started = r.client.waitFor((e) => e.type === "agent_start" && e.sessionId === active);
		await r.client.request({ id: "prompt", type: "prompt", sessionId: active, message: "hold" });
		await started;
		const parked = r.client.waitFor((e) => e.type === "session_closed" && e.sessionId === r.sessionId);
		r.drain();
		await parked;
		r.client.send({ id: "old-handle", type: "get_state", sessionId: r.sessionId });
		expect(await r.client.request({ id: "active-state", type: "get_state", sessionId: active })).toMatchObject({
			success: true,
		});
		expect(r.client.closed).toBe(false);
		const settled = r.client.waitFor((e) => e.type === "agent_settled" && e.sessionId === active);
		r.release();
		await settled;
		await r.client.waitForClose(20_000);
		expect(r.client.messages.some((e) => e.error === "unknown_session")).toBe(false);
		expect(await waitForPidGone(r.host.pid, 20_000)).toBe(true);
	}, 120_000);

	it("names the successor public socket and reopens the parked file on that generation", async () => {
		const r = await rig();
		const announced = r.client.waitFor((e) => e.type === "host_superseded", 20_000);
		const next = await r.takeover();
		expect(next.action).toBe("handoff");
		expect(await announced).toMatchObject({ successor: { socket: r.qa.socket }, instanceId: r.identity?.instanceId });
		await r.client.waitForClose(20_000);
		const successor = await r.connect();
		expect(
			await successor.request({ id: "reopen", type: "open_session", cwd: r.qa.cwd, sessionPath: r.sessionPath }),
		).toMatchObject({ success: true });
		expect(await waitForPidGone(r.host.pid, 20_000)).toBe(true);
	}, 120_000);
});
