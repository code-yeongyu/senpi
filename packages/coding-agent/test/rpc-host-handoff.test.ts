import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessStartTime } from "../src/modes/app-server/daemon/process.ts";
import { parseJson, readFileOrUndefined } from "../src/modes/rpc/host-daemon-state.ts";
import { createHostDaemonPaths, ensureHost } from "../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { signalGeneration, stopHost } from "../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	type GenerationScratch,
	generationEnv,
	generationScratch,
	HeldAnthropicModel,
	JsonlPeer,
	openedSessionId,
	socketInode,
	supervisorLaunch,
	type WireRecord,
} from "./helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";
import { processAlive, waitForPidGone } from "./helpers/spawned-host-reaper.ts";

const scratches: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];
const models: HeldAnthropicModel[] = [];
const servers: Server[] = [];
const intruderSockets: Socket[] = [];
const supervisors = new Map<number, string | undefined>();
const firstPids = new Map<string, number>();

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const model of models.splice(0)) {
		model.release();
		await model.close();
	}
	// Only processes launched in these private generation directories are owned by this test.
	// Record their identity before stopping the supervisors; never discover targets by argv.
	for (const qa of scratches) {
		const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
		for (const generation of await readdir(paths.generationsDir, { withFileTypes: true }).catch(() => [])) {
			if (!generation.isDirectory()) continue;
			for (const name of ["host.pid", "host-child.pid"]) {
				const record = parseJson(await readFileOrUndefined(join(paths.generationsDir, generation.name, name)));
				if (typeof record?.pid === "number" && typeof record.processStartTime === "string")
					supervisors.set(record.pid, record.processStartTime);
			}
		}
	}
	for (const [pid, startedAt] of supervisors) {
		if (!processAlive(pid)) continue;
		const observed = await readProcessStartTime(pid);
		// A child can follow its stopped supervisor out while the async identity probe runs.
		if (!processAlive(pid)) continue;
		if (startedAt === undefined || observed !== startedAt)
			throw new Error("Owned generation PID identity changed; refusing to signal it");
		// Never `kill` on the strength of a liveness READ: a drained generation can exit between the
		// check and the signal, and the raw ESRCH that follows fails the hook - and therefore the case
		// - for the one outcome this teardown was hoping for.
		if (!signalGeneration(pid, "SIGKILL")) continue;
		// The host child follows its supervisor's death through the lifetime pipe; removing the
		// sandbox under a host that is still writing to it is what leaves ENOTEMPTY behind.
		await waitForPidGone(pid, 20_000);
	}
	supervisors.clear();
	// A half-open probe connection would otherwise hold close() open for the whole hook budget.
	for (const socket of intruderSockets.splice(0)) socket.destroy();
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const qa of scratches.splice(0)) {
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
	firstPids.clear();
}, 120_000);

// A handoff renames one socket path over another and drains the old host with SIGUSR1;
// Windows named pipes support neither, so the whole suite is POSIX-only by construction.
describe.skipIf(process.platform === "win32")("generation handoff between live hosts", () => {
	it("parks an old connection while a new generation serves the socket", async () => {
		const qa = await generation("live");
		const inodeBefore = await socketInode(qa.socket);
		const before = await probeHost({ socket: qa.socket });
		const attached = await peer(qa);
		const sessionId = openedSessionId(await attached.request({ id: "open", type: "open_session", cwd: qa.cwd }));
		const parked = attached.waitFor((record) => record.type === "session_closed" && record.sessionId === sessionId);

		const result = await handoff(qa);

		expect(result.generation).toBe(1);
		expect(await parked).toMatchObject({ reason: "handoff_parked", sessionPath: expect.any(String) });
		await attached.waitForClose();
		// A connection made after it reaches a DIFFERENT host process.
		const after = await probeHost({ socket: qa.socket });
		expect(after?.instanceId).not.toBe(before?.instanceId);
		expect(after?.generation).toBe(1);
		const inodeAfter = await socketInode(qa.socket);
		expect(inodeAfter).not.toBe(inodeBefore);
		// The daemon directory points at the NEW generation: same pointer file, a different generation
		// directory, and the id in it is the one answering on the socket.
		const registered = await pidFile(qa);
		expect(recordedPid(registered)).toBe(result.pid);
		expect(registered.pointer_instance_id).toBe(after?.instanceId);
		expect(registered.pointer_instance_id).not.toBe(before?.instanceId);
		// The old pair leaves without waiting for its client, and preserves the public socket.
		expect(await waitForPidGone(firstPid(qa), 45_000)).toBe(true);
		expect(await socketInode(qa.socket)).toBe(inodeAfter);
		expect((await probeHost({ socket: qa.socket }))?.instanceId).toBe(after?.instanceId);
		expect(recordedPid(await pidFile(qa))).toBe(result.pid);
	}, 120_000);

	it("keeps the new generation registered when the drained supervisor is SIGKILLed", async () => {
		const held = await HeldAnthropicModel.start();
		models.push(held);
		const qa = await generation("kill9", held.origin);
		// A held TURN, not an idle attachment, pins the predecessor until the kill.
		const attached = await peer(qa);
		const sessionId = openedSessionId(await attached.request({ id: "open", type: "open_session", cwd: qa.cwd }));
		const started = attached.waitFor((record) => record.type === "agent_start" && record.sessionId === sessionId);
		await attached.request({ id: "prompt", type: "prompt", sessionId, message: "hold until killed" });
		await started;
		const result = await handoff(qa);
		const inodeAfter = await socketInode(qa.socket);
		const live = await probeHost({ socket: qa.socket });

		expect(processAlive(firstPid(qa))).toBe(true);
		expect(signalGeneration(firstPid(qa), "SIGKILL")).toBe(true);
		held.release();
		expect(await waitForPidGone(firstPid(qa), 45_000)).toBe(true);

		expect(recordedPid(await pidFile(qa))).toBe(result.pid);
		expect(await socketInode(qa.socket)).toBe(inodeAfter);
		expect((await probeHost({ socket: qa.socket }))?.instanceId).toBe(live?.instanceId);
	}, 120_000);

	it("answers session_path_in_use for an existing transcript until the old generation parks it", async () => {
		const held = await HeldAnthropicModel.start();
		models.push(held);
		const qa = await generation("path", held.origin);
		const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
		const pointer = JSON.parse(await readFile(paths.pointerFile, "utf8")) as WireRecord;
		const oldHost = JSON.parse(
			await readFile(join(paths.dir, String(pointer.generation_dir), "host-child.pid"), "utf8"),
		) as WireRecord;
		const sessionPath = join(qa.sessionDir, "held.jsonl");
		await writeFile(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "29510000-0000-4000-8000-000000000010",
				timestamp: new Date(0).toISOString(),
				cwd: qa.cwd,
			})}\n`,
		);
		const holder = await peer(qa);
		const sessionId = openedSessionId(
			await holder.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
				retain_on_disconnect: true,
			}),
		);
		const watcher = await peer(qa);
		const started = holder.waitFor((value) => value.type === "agent_start" && value.sessionId === sessionId);
		await holder.request({ id: "prompt", type: "prompt", sessionId, message: "hold this turn open" });
		await started;
		// The retained session outlives its client and stays mid-turn across the handoff.
		holder.destroy();

		await handoff(qa);

		const next = await peer(qa);
		const refused = await next.request({ id: "reopen", type: "open_session", cwd: qa.cwd, sessionPath });
		expect(refused).toMatchObject({
			success: false,
			error: "session_path_in_use",
			errorCode: "session_path_in_use",
			errorData: { owner: { pid: oldHost.pid }, retry_after_ms: 2_000 },
		});

		const parked = watcher.waitFor(
			(value) => value.type === "session_closed" && value.reason === "handoff_parked",
			90_000,
		);
		held.release();
		expect(await parked).toMatchObject({ sessionId });
		// The old generation leaves once its last session is parked.
		await watcher.waitForClose(90_000);
		expect(await waitForPidGone(firstPid(qa), 45_000)).toBe(true);

		const linesBefore = await jsonlLines(sessionPath);
		const reopened = await next.request({ id: "reopen-2", type: "open_session", cwd: qa.cwd, sessionPath });
		expect(reopened).toMatchObject({ success: true, command: "open_session" });
		const linesAfter = await jsonlLines(sessionPath);
		expect(linesAfter.length).toBeGreaterThanOrEqual(linesBefore.length);
	}, 180_000);

	it("drains the running generation on request and exits once its sessions park", async () => {
		const qa = await generation("drain");
		const client = await peer(qa);
		await client.request({
			id: "open",
			type: "open_session",
			cwd: qa.cwd,
			sessionPath: join(qa.sessionDir, "drained.jsonl"),
			retain_on_disconnect: true,
		});
		const watcher = await peer(qa);

		const stopped = await stopHost({ socket: qa.socket, agentDir: qa.agentDir, drain: true });

		expect(stopped).toMatchObject({ action: "drained", pid: firstPid(qa) });
		client.destroy();
		expect(await watcher.waitFor((value) => value.type === "session_closed", 90_000)).toMatchObject({
			reason: "handoff_parked",
		});
		await watcher.waitForClose(90_000);
		expect(await waitForPidGone(firstPid(qa), 45_000)).toBe(true);
	}, 120_000);

	it("aborts the handoff when an unmanaged server has taken the public socket", async () => {
		const qa = await generation("stolen");
		let intruderInode: number | undefined;

		const result = await handoffHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			hostArgs: [...GENERATION_HOST_ARGS],
			env: generationEnv(qa),
			_test: {
				launch: supervisorLaunch,
				beforeSpawn: async () => {
					intruderInode = await stealSocket(qa.socket);
				},
			},
		});

		expect(result).toMatchObject({ action: "refuse", reason: "socket_replaced" });
		// Nothing was renamed and nothing was unlinked: the intruder's entry is exactly as it was and
		// the successor left no bind path behind.
		expect(await socketInode(qa.socket)).toBe(intruderInode);
		await expect(stat(`${qa.socket}.next-1`)).rejects.toMatchObject({ code: "ENOENT" });
		// The handoff never signalled the running generation. It leaves anyway - the entry it bound is
		// gone, so no client can reach it by path (#1893) - and it still refuses to touch the socket
		// that replaced it or to leave a registration behind.
		expect(await waitForPidGone(firstPid(qa), 45_000)).toBe(true);
		expect(await socketInode(qa.socket)).toBe(intruderInode);
		await expect(pidFile(qa)).rejects.toMatchObject({ code: "ENOENT" });
	}, 120_000);
});

async function generation(label: string, modelOrigin?: string): Promise<GenerationScratch> {
	const qa = generationScratch(label);
	scratches.push(qa);
	writeRpcModelsJson(qa.agentDir, modelOrigin ?? "http://127.0.0.1:1");
	const ensured = await ensureHost({
		socket: qa.socket,
		agentDir: qa.agentDir,
		// Long enough that only the drain under test can end this generation.
		policy: { idleExitMs: 600_000 },
		hostArgs: [...GENERATION_HOST_ARGS],
		env: generationEnv(qa),
		_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
	});
	supervisors.set(ensured.pid, await readProcessStartTime(ensured.pid));
	firstPids.set(qa.root, ensured.pid);
	return qa;
}

function firstPid(qa: GenerationScratch): number {
	const pid = firstPids.get(qa.root);
	if (pid === undefined) throw new Error("no first generation for this scratch");
	return pid;
}

async function handoff(qa: GenerationScratch): Promise<{ pid: number; generation: number; instanceId: string }> {
	const result = await handoffHost({
		socket: qa.socket,
		agentDir: qa.agentDir,
		hostArgs: [...GENERATION_HOST_ARGS],
		env: generationEnv(qa),
		_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
	});
	if (result.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(result)}`);
	supervisors.set(result.pid, await readProcessStartTime(result.pid));
	return { pid: result.pid, generation: result.generation, instanceId: result.instanceId };
}

async function peer(qa: GenerationScratch): Promise<JsonlPeer> {
	const connected = await JsonlPeer.connect(qa.socket);
	peers.push(connected);
	return connected;
}

/** The generation the daemon directory currently points at, as a client reads it back off disk. */
async function pidFile(qa: GenerationScratch): Promise<WireRecord> {
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	const pointer = JSON.parse(await readFile(paths.pointerFile, "utf8")) as WireRecord;
	const record = JSON.parse(
		await readFile(join(paths.dir, String(pointer.generation_dir), "host.pid"), "utf8"),
	) as WireRecord;
	return { ...record, pointer_instance_id: pointer.instance_id };
}

function recordedPid(record: WireRecord): number {
	return typeof record.pid === "number" ? record.pid : 0;
}

async function jsonlLines(path: string): Promise<string[]> {
	const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
	// A single writer leaves only whole records behind; a second one would leave a torn line.
	for (const line of lines) JSON.parse(line);
	return lines;
}

/** Replaces the public socket with a live server this daemon never started; returns its inode. */
async function stealSocket(socketPath: string): Promise<number> {
	await rm(socketPath, { force: true });
	const intruder = createServer((socket) => {
		intruderSockets.push(socket);
		socket.end();
	});
	servers.push(intruder);
	await new Promise<void>((resolve) => intruder.listen(socketPath, resolve));
	return (await stat(socketPath)).ino;
}
