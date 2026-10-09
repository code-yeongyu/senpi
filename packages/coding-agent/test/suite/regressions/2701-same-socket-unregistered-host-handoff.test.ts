// Regression for senpi issue #2701: after an upgrade, an IDLE host that no layout-2 record proves - one
// from before layout 2 (only the flat `<agentDir>/rpc-host-daemon/host.pid` names it) or one with no
// provable record at all - kept the SAME socket the updated client uses. An ensure there answers `reuse`
// (the old host speaks a compatible protocol), and the handoff the client then asks for refused
// `unknown_owner`, so the client could never replace it: the desktop showed "No provider available"
// until somebody drained the old host by hand.
//
// Each host here is a REAL supervisor + host started through the production ensure and then stripped of
// every layout-2 record the way a field machine had it after an upgrade: no pointer, no `layout.json`,
// no `endpoint.json`. A handoff replaces it only while it holds no session; a busy one is never touched.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProcessStartTime } from "../../../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { type EnsuredHost, ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { type HandoffResult, handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import { signalGeneration } from "../../../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	type GenerationScratch,
	generationEnv,
	generationScratch,
	JsonlPeer,
	openedSessionId,
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
	vi.restoreAllMocks();
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

interface OldHost {
	readonly qa: GenerationScratch;
	/** The agent directory's default socket: the one the old host and the updated client share. */
	readonly socket: string;
	readonly pid: number;
	readonly instanceId: string;
	readonly flatRecord: string;
}

// A drain is SIGUSR1 and a handoff renames sockets; win32 has neither, so these cases are POSIX-only.
describe.skipIf(process.platform === "win32")("an unregistered host on the client's own socket (#2701)", () => {
	it("is replaced by a handoff when a flat legacy record proves it and it holds no session", async () => {
		const old = await startOldHost("u2a", "legacy");
		const signals = watchSignals();

		const result = await handoffOn(old);

		expect(result).toMatchObject({ action: "handoff", socket: old.socket });
		const replaced = expectHandoff(result);
		expect(replaced.pid).not.toBe(old.pid);
		expect(await waitForPidGone(old.pid, 60_000)).toBe(true);
		// The proven old host is drained, and by one of two paths only. The handoff sends it one SIGUSR1 after
		// recounting zero sessions over the held connection - unless the old host already noticed that the
		// successor took the socket (its supersession poll) and began draining itself, which closes that
		// connection, so the recount gets no answer and nothing is sent. Either way it drains; it is never
		// sent anything but a drain, and never more than one.
		const sent = signals.sentTo(old.pid);
		expect(sent.filter((signal) => signal !== "SIGUSR1")).toEqual([]);
		expect(sent.length).toBeLessThanOrEqual(1);
		if (sent.length === 0) {
			expect(await readFile(stderrLog(old), "utf8")).toContain("another generation owns the public socket");
		}
		expect((await probeHost({ socket: old.socket, timeoutMs: 10_000 }))?.instanceId).toBe(replaced.instanceId);
		// The upgraded client's next ensure attaches to the successor instead of being turned away.
		const attached = await ensureOn(old.qa, old.socket);
		expect(attached).toMatchObject({ reused: true, pid: replaced.pid });
	}, 240_000);

	it("is drained without a signal when its own supersession check wins the race against the recount (#2854)", async () => {
		// The order the release runner hit, forced: the successor already owns the socket (this hook runs after
		// it answered, before the drain gate recounts), and the old host notices that on its own poll and starts
		// draining, which closes the connection the handoff holds. The recount then gets no answer, so no
		// SIGUSR1 is sent - and the old host still drains and exits.
		const old = await startOldHost("u2f", "legacy");
		const signals = watchSignals();

		const result = await handoffOn(old, undefined, async () => {
			await vi.waitFor(
				async () =>
					expect(await readFile(stderrLog(old), "utf8")).toContain("another generation owns the public socket"),
				{ timeout: 30_000, interval: 100 },
			);
		});

		const replaced = expectHandoff(result);
		expect(await waitForPidGone(old.pid, 60_000)).toBe(true);
		expect(signals.sentTo(old.pid)).toEqual([]);
		expect((await probeHost({ socket: old.socket, timeoutMs: 10_000 }))?.instanceId).toBe(replaced.instanceId);
	}, 240_000);

	it("is replaced when no record proves any owner and it holds no session, without being signalled", async () => {
		// The flat record names the live pid with a start time that is not that process's: it proves nothing,
		// so nothing may be signalled. The successor takes the socket; the old host notices it lost the
		// public entry and drains on its own.
		const old = await startOldHost("u2b", "unprovable");
		const stderr = vi.spyOn(process.stderr, "write");
		const signals = watchSignals();

		const result = await handoffOn(old);

		expect(signals.sentTo(old.pid)).toEqual([]);
		const replaced = expectHandoff(result);
		expect(replaced.pid).not.toBe(old.pid);
		expect(await waitForPidGone(old.pid, 60_000)).toBe(true);
		expect(await readFile(stderrLog(old), "utf8")).toContain("another generation owns the public socket");
		// One warning names what is known about the predecessor nobody could prove.
		const warnings = stderr.mock.calls
			.map(([chunk]) => String(chunk))
			.filter((line) => line.includes("no provable owner"));
		stderr.mockRestore();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`no provable owner for ${old.socket}`);
		expect(warnings[0]).toContain(old.instanceId);
		expect(warnings[0]).toContain("0 sessions");
	}, 240_000);

	it("keeps a legacy host that holds a session and says how to retire it", async () => {
		const old = await startOldHost("u2c", "legacy");
		await openSessionOn(old, await connectPeer(old.socket));

		const signals = watchSignals();

		const result = await handoffOn(old);

		expect(result).toMatchObject({ action: "refuse", reason: "legacy_host" });
		const detail = result.action === "refuse" ? (result.detail ?? "") : "";
		expect(detail).toContain(`pid ${old.pid}`);
		expect(detail).toContain("1 open session");
		expect(detail).toContain("host stop --drain");
		expect(signals.sentTo(old.pid)).toEqual([]);
		expect(processAlive(old.pid)).toBe(true);
		expect((await probeHost({ socket: old.socket, timeoutMs: 10_000 }))?.instanceId).toBe(old.instanceId);
		expect(await readFile(flatPidFile(old), "utf8")).toBe(old.flatRecord);
	}, 240_000);

	it("keeps an unprovable host that holds a session", async () => {
		const old = await startOldHost("u2d", "unprovable");
		await openSessionOn(old, await connectPeer(old.socket));

		const signals = watchSignals();

		const result = await handoffOn(old);

		expect(result).toMatchObject({ action: "refuse", reason: "unknown_owner" });
		expect(result.action === "refuse" ? result.detail : undefined).toContain("1 open session");
		expect(signals.sentTo(old.pid)).toEqual([]);
		expect(processAlive(old.pid)).toBe(true);
		expect((await probeHost({ socket: old.socket, timeoutMs: 10_000 }))?.instanceId).toBe(old.instanceId);
	}, 240_000);

	it("never signals a legacy host that took a session between the count and the socket swap", async () => {
		const old = await startOldHost("u2e", "legacy");
		// Connected before the handoff: after the swap this connection still reaches the OLD host.
		const client = await connectPeer(old.socket);
		let opened: { sessionId: string; sessionPath: string } | undefined;
		const signals = watchSignals();

		// `beforeSpawn` runs after the idle count and before the successor takes the socket.
		const result = await handoffOn(old, async () => {
			opened = await openSessionOn(old, client);
		});

		expectHandoff(result);
		if (opened === undefined) throw new Error("no session was opened in the window");
		const { sessionId, sessionPath } = opened;
		// The recount saw the window's session, so the drain request was never sent.
		expect(signals.sentTo(old.pid)).toEqual([]);
		// A drain ends no work: the window's session is parked with its file and reopens on the successor.
		const parked = await client.waitFor(
			(record) => record.type === "session_closed" && record.sessionId === sessionId,
		);
		expect(parked).toMatchObject({ reason: "handoff_parked" });
		// The old generation holds the session file's path claim until it exits; then the successor reopens it.
		expect(await waitForPidGone(old.pid, 60_000)).toBe(true);
		const reopened = await (await connectPeer(old.socket)).request({
			id: "reopen",
			type: "open_session",
			cwd: old.qa.cwd,
			sessionPath,
		});
		expect(reopened, JSON.stringify(reopened.errorData ?? reopened.error)).toMatchObject({
			success: true,
			command: "open_session",
		});
	}, 240_000);
});

/**
 * A real host on the agent directory's default socket, stripped of every layout-2 record. `legacy` leaves
 * the flat record that proves it (the pre-layout-2 desktop spawner's shape); `unprovable` leaves one whose
 * start time names no live process, so no record proves who serves the socket.
 */
async function startOldHost(label: string, owner: "legacy" | "unprovable"): Promise<OldHost> {
	const qa = generationScratch(label);
	scratches.push(qa);
	writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
	const socket = join(qa.agentDir, "rpc", "rpc.sock");
	await mkdir(join(qa.agentDir, "rpc"), { recursive: true });
	const ensured = await ensureOn(qa, socket);
	// An attached client keeps a draining host resident; the old host must start with nobody on it.
	ensured.release();
	const instanceId = (await probeHost({ socket, timeoutMs: 10_000 }))?.instanceId;
	if (instanceId === undefined) throw new Error("the old host did not report an instanceId");
	const startTime = await readProcessStartTime(ensured.pid);
	if (startTime === undefined) throw new Error(`old host pid ${ensured.pid} has no readable start time`);
	const paths = createHostDaemonPaths({ socket, agentDir: qa.agentDir });
	await rm(paths.pointerFile, { force: true });
	await rm(paths.layoutMarker, { force: true });
	await rm(paths.endpointFile, { force: true });
	const processStartTime = owner === "legacy" ? startTime : "not-the-live-start-time";
	const flatRecord = `${JSON.stringify({ pid: ensured.pid, processStartTime })}\n`;
	await writeFile(paths.legacyPidFile, flatRecord, { mode: 0o600 });
	return { qa, socket, pid: ensured.pid, instanceId, flatRecord };
}

async function handoffOn(
	old: OldHost,
	beforeSpawn?: () => Promise<void>,
	beforeRegistration?: () => Promise<void>,
): Promise<HandoffResult> {
	const result = await handoffHost({
		socket: old.socket,
		agentDir: old.qa.agentDir,
		hostArgs: [...GENERATION_HOST_ARGS],
		env: generationEnv(old.qa),
		_test: {
			launch: supervisorLaunch,
			readinessTimeoutMs: 60_000,
			...(beforeSpawn ? { beforeSpawn } : {}),
			...(beforeRegistration ? { beforeRegistration } : {}),
		},
	});
	if (result.action === "handoff") supervisors.push(result.pid);
	return result;
}

function expectHandoff(result: HandoffResult): Extract<HandoffResult, { action: "handoff" }> {
	if (result.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(result)}`);
	return result;
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

async function connectPeer(socket: string): Promise<JsonlPeer> {
	const client = await JsonlPeer.connect(socket);
	peers.push(client);
	return client;
}

async function openSessionOn(old: OldHost, client: JsonlPeer): Promise<{ sessionId: string; sessionPath: string }> {
	const sessionPath = join(realpathSync(old.qa.sessionDir), `${randomUUID()}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: randomUUID(),
		timestamp: new Date(0).toISOString(),
		cwd: old.qa.cwd,
	};
	await writeFile(sessionPath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
	const opened = await client.request({ id: randomUUID(), type: "open_session", cwd: old.qa.cwd, sessionPath });
	expect(opened).toMatchObject({ success: true, command: "open_session" });
	return { sessionId: openedSessionId(opened), sessionPath };
}

function flatPidFile(old: OldHost): string {
	return createHostDaemonPaths({ socket: old.socket, agentDir: old.qa.agentDir }).legacyPidFile;
}

function stderrLog(old: OldHost): string {
	return createHostDaemonPaths({ socket: old.socket, agentDir: old.qa.agentDir }).stderrLog;
}

/**
 * Records every signal this process delivers while still delivering it: the handoff runs in-process.
 * Signal 0 is a liveness probe that delivers nothing, so it is not counted; a bare kill is SIGTERM.
 */
function watchSignals(): { sentTo(pid: number): string[] } {
	const kill = vi.spyOn(process, "kill");
	return {
		sentTo: (pid) =>
			kill.mock.calls
				.filter(([target, signal]) => target === pid && signal !== 0)
				.map(([, signal]) => String(signal ?? "SIGTERM")),
	};
}
