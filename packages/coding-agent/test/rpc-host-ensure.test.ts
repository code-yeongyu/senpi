import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import {
	ProcessIdentityUnreadableError,
	processIsLive,
	processMatchesPidFile,
	readProcessStartTime,
	waitForStartTime,
} from "../src/modes/app-server/daemon/process.ts";
import { type HostPidFileWriter, readHostRegistration } from "../src/modes/rpc/host-daemon-registration.ts";
import { GENERATION_HANDOFF_CAPABILITY, HostEnsureRefusedError } from "../src/modes/rpc/host-decision.ts";
import { createHostDaemonPaths, defaultHostLaunch, ensureHost } from "../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../src/modes/rpc/socket-transport.ts";
import { killAndWait, processesUnder, reapProcessesUnder, waitForPidGone } from "./helpers/spawned-host-reaper.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const fixture = join(import.meta.dirname, "fixtures", "rpc-host-fixture.mjs");
const incompatibleProtocolFixture = join(import.meta.dirname, "fixtures", "rpc-incompatible-protocol-host.ts");
/** What a host must advertise before any client may attach: protocol capabilities, never a version. */
const CAPABILITIES = "multi_session,extension_events,session_context,session_kind";
/** A host that can drain into a successor generation: the only kind a client may ever hand off from. */
const HANDOFF_CAPABILITIES = `${CAPABILITIES},${GENERATION_HANDOFF_CAPABILITY}`;

afterEach(async () => {
	for (const child of children.splice(0)) await killAndWait(child);
	for (const root of roots.splice(0)) {
		await stopManagedRoot(root);
		// Most hosts here are spawned by PRODUCTION code: detached, with only a pid handed back, and
		// some cases deliberately leave a registration the teardown above cannot act on (an unguarded
		// pidfile, an ensure that cleaned its own state). The sandbox path still names every one of
		// them, and the wait is what keeps the removal below from racing a host that is still writing.
		await reapProcessesUnder(root);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}, 60_000);

describe("ensureHost", () => {
	it("serializes concurrent starts for one socket across agent directories", async () => {
		const qa = await scratch("cross-agent-race");
		const secondAgentDir = join(qa.root, "other-agent");
		let releaseFirst!: () => void;
		let signalFirstLocked!: () => void;
		const firstLocked = new Promise<void>((resolve) => (releaseFirst = resolve));
		const firstAcquired = new Promise<void>((resolve) => (signalFirstLocked = resolve));
		const first = ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: {
				afterLockAcquired: async () => {
					signalFirstLocked();
					await firstLocked;
				},
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
				},
			},
		});
		await firstAcquired;
		const second = ensureHost({
			agentDir: secondAgentDir,
			socket: qa.socket,
			_test: {
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
				},
			},
		});
		releaseFirst();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.reused).toBe(false);
		expect(secondResult).toMatchObject({ socket: qa.socket, reused: true });
	}, 45_000);

	it("waits for a holder whose critical section outlasts the previous ten-second lock budget", async () => {
		const qa = await scratch("long-critical-section");
		const secondAgentDir = join(qa.root, "other-agent");
		let signalFirstLocked!: () => void;
		const firstAcquired = new Promise<void>((resolve) => (signalFirstLocked = resolve));
		const first = ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: {
				afterLockAcquired: async () => {
					signalFirstLocked();
					// Longer than the old cumulative wait (100 x 100ms): a waiter that still
					// used it gave up with a raw "database is locked" instead of reusing.
					await new Promise<void>((resolve) => setTimeout(resolve, 12_000));
				},
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
				},
			},
		});
		await firstAcquired;
		const second = ensureHost({
			agentDir: secondAgentDir,
			socket: qa.socket,
			_test: {
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
				},
			},
		});
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.reused).toBe(false);
		expect(secondResult).toMatchObject({ socket: qa.socket, reused: true });
	}, 60_000);

	it("starts a missing host and reuses it on the second call", async () => {
		const qa = await scratch("start-reuse");
		const first = await ensureFixtureHost(qa);
		const second = await ensureFixtureHost(qa);
		expect(first).toEqual({ pid: expect.any(Number), socket: qa.socket, reused: false });
		expect(second).toEqual({ pid: first.pid, socket: qa.socket, reused: true });
		expect((await protocolInfo(qa.socket)).data).toMatchObject({ serverVersion: VERSION });
	});

	it("attaches to a compatible unmanaged host", async () => {
		const qa = await scratch("compatible-unmanaged");
		const child = spawn(process.execPath, [fixture, qa.socket, VERSION, CAPABILITIES, "answer"], {
			detached: true,
			stdio: "ignore",
		});
		children.push(child);
		if (child.pid === undefined) throw new Error("fixture did not spawn");
		await waitForProtocol(qa.socket);
		const result = await ensureFixtureHost(qa);
		expect(result.reused).toBe(true);
		expect(result.pid).toBe(0);
	});

	it("reuses a compatible host whose server version differs from this build", async () => {
		// I2: two builds with different version STRINGS speak the same protocol. Replacing such a
		// host - which is what an exact-version compatibility test did - kills another client's work.
		const qa = await scratch("different-version");
		const running = await startManagedFixture(qa, { serverVersion: "2026.9.16-3" });
		const result = await ensureFixtureHost(qa);
		expect(result).toEqual({ pid: running.pid, socket: qa.socket, reused: true });
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 15_000);

	it("refuses a host missing session_context instead of starting a second one", async () => {
		const qa = await scratch("missing-capability");
		const running = await startManagedFixture(qa, {
			capabilities: "multi_session,extension_events,session_kind",
		});
		const failure = await ensureFixtureHost(qa).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("capability");
		// The host that owns the socket keeps owning it: no signal, no second host.
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 15_000);

	it("refuses to signal a live host whose pidfile another process wrote", async () => {
		// I1: the pidfile says a host is ours only if THIS process wrote it. A foreign writer's host
		// is never signalled, even when it stopped answering on the socket.
		const qa = await scratch("foreign-writer");
		const running = await startManagedProcess(qa, { writer: "foreign" });
		const failure = await ensureFixtureHost(qa).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("foreign_writer");
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 20_000);

	it("refuses a pidfile written by a recycled pid that is no longer this process", async () => {
		// The adversarial half of the same rule: the writer pid matches after a reboot recycled it,
		// so only the recorded start time separates "we wrote this" from "somebody else did".
		const qa = await scratch("recycled-writer");
		const running = await startManagedProcess(qa, { writer: "recycled-pid" });
		const failure = await ensureFixtureHost(qa).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("foreign_writer");
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 20_000);

	it("cleans a stale dead pidfile and starts fresh", async () => {
		const qa = await scratch("stale-pidfile");
		const paths = daemonPaths(qa);
		await writeRegistration(qa, { pid: 999_999_999, processStartTime: "dead" });
		await writeFile(paths.settingsFile, "stale");
		const result = await ensureFixtureHost(qa);
		expect(result.reused).toBe(false);
		expect(result.pid).not.toBe(999_999_999);
		expect(JSON.parse(await readFile(paths.settingsFile, "utf8"))).toMatchObject({ socket: qa.socket });
	});

	it("escalates to SIGKILL when our own dead host ignores SIGTERM", async () => {
		const qa = await scratch("sigkill");
		const old = await startManagedProcess(qa, { writer: "self", ignoreTerm: true });
		const startedAt = Date.now();
		const result = await ensureFixtureHost(qa, { stopTimeoutMs: 200 });
		expect(result.pid).not.toBe(old.pid);
		expect(Date.now() - startedAt).toBeLessThan(8_000);
		await expectGone(old.pidFile);
	}, 15_000);

	// win32 reaches a host through a named pipe derived from a secret file, so a stand-in listener
	// there would test the fixture's own derivation rather than this decision. The rule is
	// platform-independent; the POSIX shards prove it.
	it.skipIf(process.platform === "win32")("never signals a host whose socket still accepts connections", async () => {
		// A daemon serving many sessions can miss the probe budget while its event loop is busy.
		// Ending it would destroy every live session to replace a host that was never broken.
		const qa = await scratch("busy-socket");
		const busy = await startBusySocketHost(qa, "self");

		await expect(ensureFixtureHost(qa, { stopTimeoutMs: 200 })).rejects.toThrow(/host_busy|accepts connections/);

		expect(processIsLive(busy.pid)).toBe(true);
	}, 30_000);

	it("fails within the readiness budget and includes stderr diagnostics", async () => {
		const qa = await scratch("readiness-failure");
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 300,
				spawn: {
					command: process.execPath,
					args: ["-e", "process.stderr.write('fixture readiness diagnostic\\n'); setInterval(() => {}, 1000)"],
				},
			}),
		).rejects.toThrow(/did not answer get_protocol_info.*fixture readiness diagnostic/s);
		await expect(access(daemonPaths(qa).pointerFile)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(qa.socket)).rejects.toMatchObject({ code: "ENOENT" });
	}, 10_000);

	it("keeps the readiness diagnostic and cleans up when the identity probe fails during teardown", async () => {
		const qa = await scratch("readiness-failure-probe-error");
		// Startup succeeds (the pidfile gets a real identity); the probe starts failing only
		// once teardown begins - the exact shape of the Windows CI failure.
		let registered = false;
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 300,
				beforePidFileWrite: async () => {
					registered = true;
				},
				readProcessStartTime: (pid) =>
					registered
						? Promise.reject(new Error("Command failed: powershell.exe -NoProfile"))
						: readProcessStartTime(pid),
				spawn: {
					command: process.execPath,
					args: ["-e", "process.stderr.write('fixture readiness diagnostic\\n'); setInterval(() => {}, 1000)"],
				},
			}),
		).rejects.toThrow(/did not answer get_protocol_info.*fixture readiness diagnostic/s);
		await expect(access(daemonPaths(qa).pointerFile)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(qa.socket)).rejects.toMatchObject({ code: "ENOENT" });
	}, 10_000);

	it("reports the readiness diagnostic even when teardown cannot confirm the host died", async () => {
		const qa = await scratch("readiness-failure-stop-stuck");
		// After registration the probe keeps reporting the recorded identity even once the
		// host is dead, so any pidfile-based wait would never observe "gone". The readiness
		// diagnostic must still be the error the caller sees.
		let pinned: string | undefined;
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 300,
				stopTimeoutMs: 50,
				beforePidFileWrite: async () => {
					pinned = "pinned";
				},
				readProcessStartTime: async (pid) =>
					pinned ? ((await readProcessStartTime(pid)) ?? pinned) : readProcessStartTime(pid),
				spawn: {
					command: process.execPath,
					args: ["-e", "process.stderr.write('fixture readiness diagnostic\\n'); setInterval(() => {}, 1000)"],
				},
			}),
		).rejects.toThrow(/did not answer get_protocol_info.*fixture readiness diagnostic/s);
		await expect(access(daemonPaths(qa).pointerFile)).rejects.toMatchObject({ code: "ENOENT" });
	}, 10_000);

	it("serializes concurrent starts even when the identity probe fails transiently on a live pid", async () => {
		// The Windows CI variant: Get-CimInstance exits non-zero under load for a process that is
		// very much alive. Observation failure must read as UNKNOWN (retry), never as "gone" or
		// as an error that escapes ensureHost.
		const qa = await scratch("race-flaky");
		const secondAgentDir = join(qa.root, "other-agent");
		let failuresLeft = 3;
		const flakyProbe = async (pid: number): Promise<string | undefined> => {
			if (failuresLeft > 0) {
				failuresLeft -= 1;
				throw new Error(
					`Command failed: powershell.exe -NoProfile Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
				);
			}
			return readProcessStartTime(pid);
		};
		let releaseFirst!: () => void;
		let signalFirstLocked!: () => void;
		const firstLocked = new Promise<void>((resolve) => (releaseFirst = resolve));
		const firstAcquired = new Promise<void>((resolve) => (signalFirstLocked = resolve));
		const spawnFixture = {
			command: process.execPath,
			args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
		};
		const first = ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: {
				readProcessStartTime: flakyProbe,
				afterLockAcquired: async () => {
					signalFirstLocked();
					await firstLocked;
				},
				spawn: spawnFixture,
			},
		});
		await firstAcquired;
		const second = ensureHost({
			agentDir: secondAgentDir,
			socket: qa.socket,
			_test: { readProcessStartTime: flakyProbe, spawn: spawnFixture },
		});
		releaseFirst();
		const [a, b] = await Promise.all([first, second]);
		expect(a.reused).toBe(false);
		expect(a.pid).toBeGreaterThan(0);
		expect(b).toMatchObject({ socket: qa.socket, reused: true });
		// The flaky probe was exercised to exhaustion and never escaped as an error.
		expect(failuresLeft).toBe(0);
	}, 20_000);

	it("registers a live host whose identity stays unreadable instead of tearing it down", async () => {
		// The Windows CI variant that survived the retry work: every Get-CimInstance attempt is
		// starved, so the spawned host never yields an identity. The host itself is healthy and
		// answering, so it must be registered without an ownership guard rather than killed.
		const qa = await scratch("unreadable-identity");
		const host = await ensureFixtureHost(qa, { readProcessStartTime: async () => undefined });
		expect(host).toMatchObject({ socket: qa.socket, reused: false });
		expect((await readHostRegistration(daemonPaths(qa)))?.record).toEqual({ pid: host.pid, processStartTime: null });
		const second = await ensureFixtureHost(qa);
		expect(second).toMatchObject({ socket: qa.socket, reused: true });
	}, 20_000);

	it("starts fresh when an unguarded pidfile's host no longer answers", async () => {
		// A pidfile written without an identity guard can never authorize a kill, so a later
		// ensure must start a new host instead of failing on the unreadable identity.
		const qa = await scratch("unguarded-pidfile");
		const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
		children.push(live);
		await writeRegistration(qa, { pid: live.pid ?? 0, processStartTime: null });
		const host = await ensureFixtureHost(qa);
		expect(host.reused).toBe(false);
		expect(host.pid).not.toBe(live.pid);
	}, 20_000);

	it("treats a failing probe against a dead pid as gone and starts a fresh host", async () => {
		const qa = await scratch("dead-probe");
		// A real process that has already exited: liveness is genuinely false.
		const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
		await writeRegistration(qa, { pid: dead.pid ?? 0, processStartTime: "stale" });
		let probeCalls = 0;
		const host = await ensureFixtureHost(qa, {
			readProcessStartTime: async (pid) => {
				probeCalls += 1;
				if (pid === dead.pid) throw new Error("Command failed: powershell.exe -NoProfile");
				return readProcessStartTime(pid);
			},
		});
		expect(host.reused).toBe(false);
		expect(host.pid).not.toBe(dead.pid);
		expect(probeCalls).toBeGreaterThan(0);
	}, 20_000);

	it("fails fast when the spawned host exits before readiness", async () => {
		const qa = await scratch("early-exit");
		const startedAt = Date.now();
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 5_000,
				spawn: { command: process.execPath, args: ["-e", "process.exit(7)"] },
			}),
		).rejects.toThrow(/exited.*7/);
		expect(Date.now() - startedAt).toBeLessThan(2_500);
	}, 10_000);

	it("reports an incompatible protocol answer instead of a readiness timeout", async () => {
		const qa = await scratch("incompatible-answer");
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 10_000,
				spawn: {
					command: process.execPath,
					args: ["--import", "tsx", incompatibleProtocolFixture, qa.socket],
				},
			}),
		).rejects.toThrow(/incompatible|0\\.0\\.0-wrong/);
	}, 30_000);
});

/**
 * Identity of the endpoint the host is serving, used to prove a REUSE did not quietly
 * re-create it. On a filesystem socket that is the inode; on win32 the endpoint is a named
 * pipe, which `stat` cannot resolve at all, so there is nothing to compare - the reuse is
 * still proven there by `reused: true` and by the pidfile still naming the same process.
 */
async function socketIdentity(socketPath: string): Promise<{ ino: number } | undefined> {
	if (process.platform === "win32") return undefined;
	const info = await stat(socketPath);
	return { ino: info.ino };
}

describe("generation handoff", () => {
	it("never hands off by default, even to an older host that can drain", async () => {
		// The default upgrade policy is `never`: finding an older, drainable host is not a reason to
		// replace it. Only a caller that explicitly asks for an upgrade may start a second generation.
		const qa = await scratch("default-never");
		const running = await startManagedFixture(qa, {
			capabilities: HANDOFF_CAPABILITIES,
			identity: fixtureIdentity({ engineOrdinal: [2026, 1, 1, 0, 0] }),
		});
		const before = await socketIdentity(qa.socket);

		const result = await ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			hostArgs: ["--provider", "mock"],
			_test: { launch: refuseToSpawn },
		});

		expect(result).toEqual({ pid: running.pid, socket: qa.socket, reused: true });
		if (before) expect(await socketIdentity(qa.socket)).toMatchObject({ ino: before.ino });
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 20_000);

	it("spawns nothing when the running generation is newer than this build", async () => {
		// d2: an older client that arrives after a handoff attaches to the newer generation. A handoff
		// is monotonic - it only ever moves forward - so this client must not start a third generation.
		const qa = await scratch("older-client");
		const running = await startManagedFixture(qa, {
			capabilities: HANDOFF_CAPABILITIES,
			identity: fixtureIdentity({ engineOrdinal: [9999, 1, 1, 0, 0] }),
		});
		const before = await socketIdentity(qa.socket);

		const result = await ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			upgrade: "if-engine-differs",
			_test: { launch: refuseToSpawn },
		});

		expect(result).toEqual({ pid: running.pid, socket: qa.socket, reused: true });
		if (before) expect(await socketIdentity(qa.socket)).toMatchObject({ ino: before.ino });
	}, 20_000);

	it("refuses to hand off from a legacy host that cannot drain", async () => {
		// b4: a host from before the drain handler has no SIGUSR1 handler at all, so signalling it would
		// KILL it. It is neither renamed nor signalled - it keeps owning the socket it is serving.
		const qa = await scratch("legacy-host");
		const running = await startManagedFixture(qa, {
			identity: fixtureIdentity({ engineOrdinal: [2026, 1, 1, 0, 0] }),
		});
		const before = await socketIdentity(qa.socket);

		const decision = await handoffHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			_test: { launch: refuseToSpawn },
		});

		// Both platforms refuse and neither touches the running host; they differ in WHY. On win32 the
		// refusal is decided before the host is even probed - a named pipe can be neither renamed nor
		// drained - so the reason is the platform's, not the legacy host's.
		expect(decision).toMatchObject({
			action: "refuse",
			reason: process.platform === "win32" ? "upgrade_unsupported" : "handoff_unsupported",
			upgradeable: false,
		});
		if (before) expect(await socketIdentity(qa.socket)).toMatchObject({ ino: before.ino });
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 20_000);

	it("refuses an upgrade on win32, where a pipe can neither be renamed nor drained", async () => {
		const qa = await scratch("win32-refuse");
		await startManagedFixture(qa, { capabilities: HANDOFF_CAPABILITIES, identity: fixtureIdentity({}) });

		const decision = await handoffHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			_test: { launch: refuseToSpawn, platform: "win32" },
		});

		expect(decision).toMatchObject({ action: "refuse", reason: "upgrade_unsupported" });
	}, 20_000);

	it("leaves a daemon on another socket running when this agent directory ensures a second one", async () => {
		// b2: today's daemon directory holds ONE pidfile per agent directory, so an ensure for a
		// different socket read the running daemon's record as its own and stopped it. A record that
		// names another endpoint is not this ensure's host, whoever wrote it.
		const qa = await scratch("other-socket");
		const running = await startManagedFixture(qa);
		const otherSocket = join(qa.root, "other.sock");

		const second = await ensureHost({
			agentDir: qa.agentDir,
			socket: otherSocket,
			_test: {
				spawn: { command: process.execPath, args: [fixture, otherSocket, VERSION, CAPABILITIES, "answer"] },
			},
		});

		expect(second.reused).toBe(false);
		expect(second.pid).not.toBe(running.pid);
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 20_000);
});

// The fixture serves a filesystem socket and is reaped through `pgrep`; win32 has neither.
describe.skipIf(process.platform === "win32")("protocol fixture self-termination", () => {
	it("exits when the socket it serves disappears", async () => {
		// Most fixture hosts are spawned DETACHED by production code, so a case that leaves an
		// unusable registration behind has no handle to stop them with. Their sandbox going away is
		// the signal that nothing needs them any more.
		const qa = await scratch("fixture-socket-gone");
		const host = await spawnFixture(qa);

		await rm(qa.socket, { force: true });

		expect(await waitForPidGone(host, 15_000)).toBe(true);
	}, 30_000);

	it("exits when the process that started it is gone", async () => {
		// A SIGKILLed test runner cannot run any teardown at all; the fixture notices that it has
		// been reparented and leaves on its own.
		const qa = await scratch("fixture-orphan");
		const launcher = spawn(
			process.execPath,
			[
				"-e",
				"const { spawn } = require('node:child_process');" +
					"spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' }).unref();" +
					"setInterval(() => {}, 1000);",
				fixture,
				qa.socket,
				VERSION,
				CAPABILITIES,
				"answer",
			],
			{ stdio: "ignore" },
		);
		children.push(launcher);
		await waitForProtocol(qa.socket);
		const host = processesUnder(qa.root).find((pid) => pid !== launcher.pid);
		expect(host).toBeGreaterThan(0);

		await killAndWait(launcher);

		expect(await waitForPidGone(host ?? 0, 15_000)).toBe(true);
	}, 30_000);
});

describe("defaultHostLaunch", () => {
	it("re-enters through the internal supervisor route in compiled binaries", () => {
		expect(defaultHostLaunch(["--socket", "/tmp/qa.sock", "--provider", "mock"], true)).toEqual({
			command: process.execPath,
			args: ["--internal-rpc-host-supervisor", "--socket", "/tmp/qa.sock", "--provider", "mock"],
		});
	});

	it("forwards a generation bind and its replace guard to the supervisor", () => {
		expect(
			defaultHostLaunch(["--socket", "/tmp/qa.sock", "--bind", "/tmp/qa.sock.next-1", "--replace", "16:42"], true),
		).toEqual({
			command: process.execPath,
			args: [
				"--internal-rpc-host-supervisor",
				"--socket",
				"/tmp/qa.sock",
				"--bind",
				"/tmp/qa.sock.next-1",
				"--replace",
				"16:42",
			],
		});
	});

	it("re-enters through the host-lifecycle script outside compiled binaries", () => {
		const launch = defaultHostLaunch(["--socket", "/tmp/qa.sock", "--provider", "mock"], false);
		expect(launch.command).toBe(process.execPath);
		const args = launch.args.slice(process.execArgv.length);
		expect(args[0]).toMatch(/host-lifecycle\.(ts|js)$/);
		expect(args.slice(1)).toEqual(["--socket", "/tmp/qa.sock", "--provider", "mock"]);
	});
});

/** Every spawn seam a case that must NOT start a generation passes; firing it fails that case. */
const refuseToSpawn = (): never => {
	throw new Error("a host was spawned when none should have been");
};

/** A `get_protocol_info` identity for a fixture host, defaulting to a build older than this tree. */
function fixtureIdentity(overrides: {
	engineOrdinal?: readonly number[];
	instanceId?: string;
	generation?: number;
}): Record<string, unknown> {
	const engineOrdinal = overrides.engineOrdinal ?? [2026, 1, 1, 0, 0];
	return {
		instanceId: overrides.instanceId ?? "fixture-instance",
		generation: overrides.generation ?? 0,
		engineVersion: `${engineOrdinal.slice(0, 3).join(".")}`,
		engineOrdinal,
		launch_profile: {
			profile_id: "fixture-profile",
			core: { extensions: [], multi_session: true, session_runtime: "in-process" },
		},
	};
}

type Qa = { root: string; agentDir: string; socket: string };

function daemonPaths(qa: Qa) {
	return createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
}

/**
 * A registration in the shape a client reads it back: the pointer names a generation, and the
 * generation record is what carries the pid, its identity guard and the writer that may stop it.
 */
async function writeRegistration(
	qa: Qa,
	record: { pid: number; processStartTime: string | null },
	writer?: HostPidFileWriter,
): Promise<void> {
	const paths = daemonPaths(qa);
	const instanceId = `fixture-${record.pid}`;
	const stamp = writer ?? { pid: process.pid, startTime: (await readProcessStartTime(process.pid)) ?? null };
	await mkdir(join(paths.generationsDir, instanceId), { recursive: true, mode: 0o700 });
	await writeFile(
		join(paths.generationsDir, instanceId, "host.pid"),
		`${JSON.stringify({ ...record, instance_id: instanceId, socket: qa.socket, writer: stamp })}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		paths.pointerFile,
		`${JSON.stringify({ layout: 2, instance_id: instanceId, generation_dir: `generations/${instanceId}`, writer: stamp })}\n`,
		{ mode: 0o600 },
	);
}
/** Who the pidfile claims wrote it: this process, this process's pid after a reboot recycled it, or the host itself. */
type Writer = "self" | "recycled-pid" | "foreign";
type Managed = { pid: number; pidFile: { pid: number; processStartTime: string } };
type Overrides = {
	readinessTimeoutMs?: number;
	stopTimeoutMs?: number;
	spawn?: { command: string; args: string[] };
	readProcessStartTime?: (pid: number) => Promise<string | undefined>;
	beforePidFileWrite?: () => Promise<void>;
};

async function scratch(label: string): Promise<Qa> {
	const root = await mkdtemp(join(tmpdir(), `senpi-host-ensure-${label}-`));
	roots.push(root);
	return { root, agentDir: join(root, "agent"), socket: join(root, "rpc.sock") };
}

function ensureFixtureHost(qa: Qa, overrides: Overrides = {}) {
	return ensureHost({
		agentDir: qa.agentDir,
		socket: qa.socket,
		_test: {
			readinessTimeoutMs: overrides.readinessTimeoutMs,
			stopTimeoutMs: overrides.stopTimeoutMs,
			spawn: overrides.spawn ?? {
				command: process.execPath,
				args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
			},
			readProcessStartTime: overrides.readProcessStartTime,
			beforePidFileWrite: overrides.beforePidFileWrite,
		},
	});
}

/** A fixture host nobody registers, answering on its sandbox socket. Returns its pid. */
async function spawnFixture(qa: Qa): Promise<number> {
	const child = spawn(process.execPath, [fixture, qa.socket, VERSION, CAPABILITIES, "answer"], {
		detached: true,
		stdio: "ignore",
	});
	children.push(child);
	if (child.pid === undefined) throw new Error("fixture did not spawn");
	await waitForProtocol(qa.socket);
	return child.pid;
}

async function startManagedFixture(
	qa: Qa,
	options: {
		serverVersion?: string;
		capabilities?: string;
		writer?: Writer;
		identity?: Record<string, unknown>;
	} = {},
): Promise<Managed> {
	const child = spawn(
		process.execPath,
		[
			fixture,
			qa.socket,
			options.serverVersion ?? VERSION,
			options.capabilities ?? CAPABILITIES,
			"answer",
			JSON.stringify(options.identity ?? {}),
		],
		{ detached: true, stdio: "ignore" },
	);
	await waitForProtocol(qa.socket);
	return register(qa, child, options.writer ?? "self");
}

/**
 * A managed host that does NOT answer on the socket: the shape a wedged or dead host leaves behind,
 * where the only thing standing between an ensure and a signal is the pidfile's writer.
 */
async function startManagedProcess(qa: Qa, options: { writer: Writer; ignoreTerm?: boolean }): Promise<Managed> {
	const script = options.ignoreTerm
		? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
		: "setInterval(() => {}, 1000)";
	return register(qa, spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" }), options.writer);
}

/**
 * A host that is ALIVE and OWNS the socket, but never answers: it accepts every connection and then
 * stays silent. That is a busy daemon, not a dead one, and the difference decides whether an ensure
 * may end it. The path arrives by env (an `-e` script's argv is not worth relying on) and a stale
 * path is removed first, so a reused scratch directory cannot fail the listen.
 */
async function startBusySocketHost(qa: Qa, writer: Writer): Promise<Managed> {
	const script = [
		'const net = require("node:net"), fs = require("node:fs");',
		'try { fs.unlinkSync(process.env.BUSY_SOCKET) } catch {}',
		'const server = net.createServer(() => {});',
		'server.on("error", (error) => { process.stderr.write(String(error)); process.exit(1) });',
		'server.listen(process.env.BUSY_SOCKET, () => process.stdout.write("listening\\n"));',
		"setInterval(() => {}, 1000);",
	].join(" ");
	const child = spawn(process.execPath, ["-e", script], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, BUSY_SOCKET: qa.socket },
	});
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.stderr?.once("data", (chunk: Buffer) => reject(new Error(`busy host failed to listen: ${chunk.toString("utf8")}`)));
		child.once("exit", (code) => reject(new Error(`busy host exited before listening (code ${code})`)));
	});
	return register(qa, child, writer);
}

async function register(qa: Qa, child: ChildProcess, writer: Writer): Promise<Managed> {
	children.push(child);
	if (child.pid === undefined) throw new Error("managed host did not spawn");
	// waitForStartTime returns undefined when every identity probe inside the budget is starved
	// (a loaded windows-latest runner makes each Get-CimInstance call outlive its 1 s default) while
	// the child is still alive. Production gives that wait 10 s; the fixture must not be stricter,
	// and a live child with no identity yet is an observability gap, not a spawn failure (#1817).
	const processStartTime = await waitForStartTime(child.pid, 10_000);
	if (processStartTime === undefined) {
		if (!processIsLive(child.pid)) throw new Error("managed host died before publishing its identity");
		throw new Error(`managed host ${child.pid} is live but its identity probe was starved for 10 s`);
	}
	await writeRegistration(qa, { pid: child.pid, processStartTime }, await writerRecord(writer, child.pid));
	await writeFile(daemonPaths(qa).settingsFile, `${JSON.stringify({ socket: qa.socket })}\n`, { mode: 0o600 });
	return { pid: child.pid, pidFile: { pid: child.pid, processStartTime } };
}

async function writerRecord(writer: Writer, hostPid: number): Promise<{ pid: number; startTime: string | null }> {
	if (writer === "self") return { pid: process.pid, startTime: (await readProcessStartTime(process.pid)) ?? null };
	// A recycled pid carries this process's number with somebody else's start time.
	if (writer === "recycled-pid") return { pid: process.pid, startTime: "1970-01-01T00:00:00.000Z" };
	return { pid: hostPid, startTime: (await readProcessStartTime(hostPid)) ?? null };
}

async function protocolInfo(socketPath: string): Promise<Record<string, unknown>> {
	const secret = process.platform === "win32" ? await readSocketSecret(socketSecretPath(socketPath)) : undefined;
	return new Promise((resolve, reject) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		let buffer = "";
		const timer = setTimeout(() => finish(new Error("protocol timeout")), 1_000);
		const finish = (error?: Error, value?: Record<string, unknown>) => {
			clearTimeout(timer);
			socket.destroy();
			error ? reject(error) : resolve(value!);
		};
		socket.once("connect", () => {
			if (secret) sendSocketHandshake(socket, secret);
			socket.write('{"id":"probe","type":"get_protocol_info"}\n');
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline !== -1) finish(undefined, JSON.parse(buffer.slice(0, newline)));
		});
		socket.once("error", finish);
	});
}

async function waitForProtocol(socketPath: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() <= deadline) {
		try {
			await protocolInfo(socketPath);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error("fixture protocol did not become ready");
}

async function expectGone(pidFile: { pid: number; processStartTime: string }): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() <= deadline) {
		if (!(await processMatchesPidFile(pidFile, readProcessStartTime))) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`pid ${pidFile.pid} remained alive`);
}

async function stopManagedRoot(root: string): Promise<void> {
	const agentDir = join(root, "agent");
	const registered = await readHostRegistration(
		createHostDaemonPaths({ socket: join(root, "rpc.sock"), agentDir }),
	).catch(() => undefined);
	const record = registered?.record;
	if (!record || record.processStartTime === null) return;
	const identity = { pid: record.pid, processStartTime: record.processStartTime };
	if (!(await processMatchesPidFile(identity, readProcessStartTime))) return;
	process.kill(identity.pid, "SIGKILL");
	await expectGone(identity);
}

describe("processMatchesPidFile", () => {
	it("retries a probe that fails transiently against a live pid and then answers", async () => {
		let failures = 2;
		let calls = 0;
		const matches = await processMatchesPidFile(
			{ pid: process.pid, processStartTime: "self" },
			async () => {
				calls += 1;
				if (failures > 0) {
					failures -= 1;
					throw new Error("Command failed: powershell.exe -NoProfile");
				}
				return "self";
			},
			() => true,
			{ attempts: 5, delayMs: 5 },
		);
		expect(matches).toBe(true);
		expect(calls).toBe(3);
	});

	it("reads a pidfile without an identity guard as unreadable while the pid is live", async () => {
		await expect(
			processMatchesPidFile(
				{ pid: process.pid, processStartTime: null },
				async () => "ignored",
				() => true,
				{
					attempts: 1,
				},
			),
		).rejects.toBeInstanceOf(ProcessIdentityUnreadableError);
	});

	it("reads a pidfile without an identity guard as gone once the pid is not live", async () => {
		await expect(
			processMatchesPidFile(
				{ pid: 4_294_967_294, processStartTime: null },
				async () => "ignored",
				() => false,
				{
					attempts: 1,
				},
			),
		).resolves.toBe(false);
	});

	it("reads a failing probe against a dead pid as gone without retrying", async () => {
		let calls = 0;
		const matches = await processMatchesPidFile(
			{ pid: 999_999, processStartTime: "x" },
			async () => {
				calls += 1;
				throw new Error("Command failed: powershell.exe -NoProfile");
			},
			() => false,
			{ attempts: 5, delayMs: 5 },
		);
		expect(matches).toBe(false);
		expect(calls).toBe(1);
	});

	it("surfaces an exhausted probe on a live pid as ProcessIdentityUnreadableError, not the raw probe error", async () => {
		await expect(
			processMatchesPidFile(
				{ pid: process.pid, processStartTime: "self" },
				async () => {
					throw new Error("Command failed: powershell.exe -NoProfile");
				},
				() => true,
				{ attempts: 3, delayMs: 5 },
			),
		).rejects.toBeInstanceOf(ProcessIdentityUnreadableError);
	});
});
