// Regression for senpi issue #2423: a live host from before layout 2 - known only through the FLAT
// `<agentDir>/rpc-host-daemon/host.pid` - could never be retired by an updated client. `ensureHost`
// refused every endpoint with `legacy_host` while that record named a live process, and
// `stopHost({ drain: true })` answered `unknown_owner` because only a layout-2 pointer proved an owner.
//
// The legacy host here is a REAL supervisor + host. It is started through the production ensure,
// then made legacy the way the incident's machine had it: its layout-2 pointer is gone and the flat
// record `{ pid, processStartTime }` is the only thing naming it. It still advertises
// `generation_handoff`, so SIGUSR1 drains it - exactly what the old engine did when drained by hand.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessStartTime } from "../../../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { HostEnsureRefusedError } from "../../../src/modes/rpc/host-decision.ts";
import { type EnsuredHost, ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import { signalGeneration, stopHost } from "../../../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	type GenerationScratch,
	generationEnv,
	generationScratch,
	JsonlPeer,
	processAlive,
	supervisorLaunch,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { reapProcessesUnder, waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

const scratches: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];
const supervisors: number[] = [];
const releases: Array<() => void> = [];

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const peer of peers.splice(0)) peer.destroy();
	for (const pid of supervisors.splice(0)) {
		// A drained generation can exit between any liveness read and this signal; ESRCH is success.
		if (!signalGeneration(pid, "SIGKILL")) continue;
		await waitForPidGone(pid, 20_000);
	}
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

interface LegacyHost {
	readonly qa: GenerationScratch;
	/** The endpoint an unstamped flat record describes: the agent directory's default socket. */
	readonly socket: string;
	readonly pid: number;
	readonly flatRecord: string;
}

// A drain is SIGUSR1 and a handoff renames sockets; win32 has neither, so these cases are POSIX-only.
describe.skipIf(process.platform === "win32")("a live pre-layout-2 host (#2423)", () => {
	it("is drained by `stop --drain` when its flat record proves the process", async () => {
		const legacy = await startLegacyHost("l2d");

		const result = await stopHost({ socket: legacy.socket, agentDir: legacy.qa.agentDir, drain: true });

		expect(result).toEqual({ action: "drained", pid: legacy.pid });
		expect(await waitForPidGone(legacy.pid, 60_000)).toBe(true);
	}, 180_000);

	it("is drained and replaced by an ensure when it holds no session", async () => {
		const legacy = await startLegacyHost("l2e");
		// The incident's shape: the updated client ensures ITS OWN endpoint (a per-thread socket), which
		// nothing serves, while the legacy host keeps the agent directory's default socket.
		const threadSocket = join(legacy.qa.root, "t.sock");

		const ensured = await ensureOn(legacy.qa, threadSocket);

		expect(ensured.reused).toBe(false);
		expect(ensured.pid).not.toBe(legacy.pid);
		expect(await waitForPidGone(legacy.pid, 60_000)).toBe(true);
		expect(await probeHost({ socket: threadSocket, timeoutMs: 10_000 })).toBeDefined();
	}, 240_000);

	it("keeps refusing with an actionable legacy_host while it holds a session", async () => {
		const legacy = await startLegacyHost("l2s");
		const sessionPath = join(realpathSync(legacy.qa.sessionDir), "held.jsonl");
		await writeFile(sessionPath, sessionHeader(legacy.qa.cwd), { mode: 0o600 });
		const client = await JsonlPeer.connect(legacy.socket);
		peers.push(client);
		expect(await client.request({ id: "open", type: "open_session", cwd: legacy.qa.cwd, sessionPath })).toMatchObject(
			{ success: true, command: "open_session" },
		);
		const threadSocket = join(legacy.qa.root, "t.sock");

		const failure = await ensureOn(legacy.qa, threadSocket).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("legacy_host");
		// What to do about it, named: the process, the endpoint it serves, and the command that drains it.
		expect((failure as Error).message).toContain(`pid ${legacy.pid}`);
		expect((failure as Error).message).toContain(legacy.socket);
		expect((failure as Error).message).toContain("1 open session");
		expect((failure as Error).message).toContain("host stop --drain");
		expect(processAlive(legacy.pid)).toBe(true);
		expect(await readFile(flatPidFile(legacy), "utf8")).toBe(legacy.flatRecord);
	}, 240_000);

	it("is never signalled when the flat record's start time names another process (pid reuse)", async () => {
		const legacy = await startLegacyHost("l2r");
		// Same pid, different identity guard: the record describes a process that is gone, and the live
		// process now holding that pid proves nothing. Neither a drain nor an ensure may signal it.
		const stale = `${JSON.stringify({ pid: legacy.pid, processStartTime: "not-the-live-start-time" })}\n`;
		await writeFile(flatPidFile(legacy), stale, { mode: 0o600 });

		const stop = await stopHost({ socket: legacy.socket, agentDir: legacy.qa.agentDir, drain: true });
		const threadSocket = join(legacy.qa.root, "t.sock");
		const ensured = await ensureOn(legacy.qa, threadSocket);

		expect(stop).toEqual({ action: "refuse", reason: "unknown_owner" });
		expect(ensured.pid).not.toBe(legacy.pid);
		expect(processAlive(legacy.pid)).toBe(true);
		expect(await probeHost({ socket: legacy.socket, timeoutMs: 10_000 })).toBeDefined();
	}, 240_000);

	it("is not drained by a stop aimed at an endpoint its record does not name", async () => {
		const legacy = await startLegacyHost("l2o");
		// The last pre-layout-2 build stamped the endpoint into the flat record. A stop for another
		// socket may not borrow that proof, even though the pid and start time are live.
		const startTime = await readProcessStartTime(legacy.pid);
		const elsewhere = join(legacy.qa.root, "elsewhere.sock");
		await writeFile(
			flatPidFile(legacy),
			`${JSON.stringify({ pid: legacy.pid, processStartTime: startTime, socket: elsewhere })}\n`,
			{ mode: 0o600 },
		);

		const result = await stopHost({ socket: legacy.socket, agentDir: legacy.qa.agentDir, drain: true });

		expect(result).toEqual({ action: "refuse", reason: "unknown_owner" });
		expect(processAlive(legacy.pid)).toBe(true);
	}, 180_000);
});

/**
 * A real host on the agent directory's default socket that only a FLAT record names: the production
 * ensure starts it, then its layout-2 pointer is removed and the pre-layout-2 record written instead.
 */
async function startLegacyHost(label: string): Promise<LegacyHost> {
	const qa = generationScratch(label);
	scratches.push(qa);
	writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
	const socket = join(qa.agentDir, "rpc", "rpc.sock");
	await mkdir(join(qa.agentDir, "rpc"), { recursive: true });
	const ensured = await ensureOn(qa, socket);
	// An attached client keeps a draining host resident; the legacy host must start with nobody on it.
	ensured.release();
	const startTime = await readProcessStartTime(ensured.pid);
	if (startTime === undefined) throw new Error(`legacy host pid ${ensured.pid} has no readable start time`);
	const paths = createHostDaemonPaths({ socket, agentDir: qa.agentDir });
	await rm(paths.pointerFile, { force: true });
	const flatRecord = `${JSON.stringify({ pid: ensured.pid, processStartTime: startTime })}\n`;
	await writeFile(paths.legacyPidFile, flatRecord, { mode: 0o600 });
	return { qa, socket, pid: ensured.pid, flatRecord };
}

async function ensureOn(qa: GenerationScratch, socket: string): Promise<EnsuredHost> {
	const ensured = await ensureHost({
		socket,
		agentDir: qa.agentDir,
		// Long enough that only the act under test can end a generation.
		policy: { idleExitMs: 600_000 },
		hostArgs: [...GENERATION_HOST_ARGS],
		env: generationEnv(qa),
		_test: { readinessTimeoutMs: 60_000, stopTimeoutMs: 60_000, launch: supervisorLaunch },
	});
	supervisors.push(ensured.pid);
	releases.push(ensured.release);
	return ensured;
}

function flatPidFile(legacy: LegacyHost): string {
	return createHostDaemonPaths({ socket: legacy.socket, agentDir: legacy.qa.agentDir }).legacyPidFile;
}

function sessionHeader(cwd: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date(0).toISOString(), cwd })}\n`;
}
