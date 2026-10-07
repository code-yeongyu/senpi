import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { on, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { processIsLive, processMatchesPidFile, readProcessStartTime } from "../src/modes/app-server/daemon/process.ts";
import { readHostRegistration } from "../src/modes/rpc/host-daemon-registration.ts";
import { createHostDaemonPaths, ensureHost, type HostLifecyclePolicyInput } from "../src/modes/rpc/host-ensure.ts";
import {
	DEFAULT_HOST_IDLE_EXIT_MS,
	findInternalSupervisorArgs,
	HOST_COLD_START_ENV,
	HOST_IDLE_EXIT_MS_ENV,
	IdleExitDecider,
	INTERNAL_SUPERVISOR_FLAG,
	resolveHostChildLaunch,
	resolveHostPolicy,
	spawnableChildLaunch,
} from "../src/modes/rpc/host-lifecycle.ts";
import {
	armHostWatchdog,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_PPID_ENV,
	readHostWatchdogConfig,
} from "../src/modes/rpc/host-watchdog.ts";
import {
	authenticateSocket,
	createSocketSecret,
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../src/modes/rpc/socket-transport.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";
import { processAlive, reapProcessesUnder } from "./helpers/spawned-host-reaper.ts";

const roots: string[] = [];
const peers: JsonlPeer[] = [];
const models: HeldAnthropicModel[] = [];
const managed: Array<{ pidFile: { pid: number; processStartTime: string }; pidFilePath: string }> = [];
const collisionChildFixture = join(import.meta.dirname, "fixtures", "rpc-collision-child.ts");
// Windows supervisor-exit observation is load-dependent; teardown is eventually
// consistent within the watchdog fallback bound, so the affected waits allow 30s.
const WINDOWS_SUPERVISOR_EXIT_TIMEOUT_MS = 30_000;

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const model of models.splice(0)) await model.close();
	for (const entry of managed.splice(0)) await stopHostProcess(entry.pidFile, entry.pidFilePath);
	for (const root of roots.splice(0)) {
		// Supervisors are detached and a failed ensure leaves no registration to stop them by; the
		// sandbox path names every process this file started, so nothing outlives its directory.
		await reapProcessesUnder(root);
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
	// Budget: teardown liveness probe (~1s) + SIGTERM exit wait (30s) + SIGKILL
	// escalation (2s) per host, with headroom; the old 30s cap already sat below
	// the pre-existing 33s worst case.
}, 60_000);

type RecordValue = Record<string, unknown>;

interface Scratch {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly cwd: string;
	readonly socket: string;
	readonly pidFilePath: string;
}

describe("host lifecycle policy resolution", () => {
	it("documents the default policy: transient cold start with a 15 minute idle window", () => {
		expect(resolveHostPolicy(undefined, {})).toEqual({
			coldStart: "transient",
			idleExitMs: DEFAULT_HOST_IDLE_EXIT_MS,
		});
		expect(DEFAULT_HOST_IDLE_EXIT_MS).toBe(15 * 60_000);
	});

	it("reads the policy from settings.json", () => {
		expect(resolveHostPolicy({ coldStart: "persistent", idleExitMs: 42 }, {})).toEqual({
			coldStart: "persistent",
			idleExitMs: 42,
		});
	});

	it("env overrides beat settings.json and invalid values fall through", () => {
		expect(
			resolveHostPolicy({ coldStart: "persistent", idleExitMs: 42 }, { [HOST_COLD_START_ENV]: "transient" }),
		).toEqual({
			coldStart: "transient",
			idleExitMs: 42,
		});
		expect(resolveHostPolicy({ coldStart: "transient" }, { [HOST_IDLE_EXIT_MS_ENV]: "7" })).toEqual({
			coldStart: "transient",
			idleExitMs: 7,
		});
		expect(resolveHostPolicy({ coldStart: "persistent" }, { [HOST_COLD_START_ENV]: "nonsense" })).toEqual({
			coldStart: "persistent",
			idleExitMs: DEFAULT_HOST_IDLE_EXIT_MS,
		});
		expect(resolveHostPolicy({ idleExitMs: -5 }, { [HOST_IDLE_EXIT_MS_ENV]: "0" })).toEqual({
			coldStart: "transient",
			idleExitMs: DEFAULT_HOST_IDLE_EXIT_MS,
		});
	});
});

describe("idle exit decision core", () => {
	function fakeClock(start: number): { now: () => number; advance: (ms: number) => void } {
		let current = start;
		return { now: () => current, advance: (ms: number) => (current += ms) };
	}

	it("exits only after the window elapsed with continuous idle", () => {
		const clock = fakeClock(1_000);
		const decider = new IdleExitDecider(600, clock.now);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		clock.advance(599);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		clock.advance(1);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("exit");
	});

	it("activity resets the window; a connection or turn holds the host open", () => {
		const clock = fakeClock(0);
		const decider = new IdleExitDecider(600, clock.now);
		decider.update({ connections: 0, activeTurns: 0 });
		clock.advance(500);
		expect(decider.update({ connections: 1, activeTurns: 0 })).toBe("active");
		clock.advance(60_000);
		expect(decider.update({ connections: 1, activeTurns: 0 })).toBe("active");
		expect(decider.update({ connections: 0, activeTurns: 2 })).toBe("active");
		clock.advance(60_000);
		expect(decider.update({ connections: 0, activeTurns: 2 })).toBe("active");
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		clock.advance(599);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		clock.advance(1);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("exit");
	});

	it("an infinite window (persistent cold start) never exits", () => {
		const clock = fakeClock(0);
		const decider = new IdleExitDecider(Number.POSITIVE_INFINITY, clock.now);
		decider.update({ connections: 0, activeTurns: 0 });
		clock.advance(Number.MAX_SAFE_INTEGER);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
	});
});

describe("ensureHost-spawned host lifecycle", () => {
	// #1290: an ensure readiness connection can fit entirely between idle ticks.
	it("resets the idle window for a connection entirely between timer ticks", async () => {
		const qa = scratch("clock");
		const supervisor = spawn(
			process.execPath,
			["--import", "tsx", join(import.meta.dirname, "fixtures", "rpc-lifecycle-clock.ts"), qa.socket, qa.agentDir],
			{
				env: {
					...process.env,
					...hermeticProviderEnv(),
					SENPI_CODING_AGENT_DIR: qa.agentDir,
					SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
					[HOST_IDLE_EXIT_MS_ENV]: "800",
				},
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			},
		);
		const exited = once(supervisor, "exit", { signal: AbortSignal.timeout(30_000) });
		try {
			await supervisorMessage(supervisor, "ready");
			await advanceSupervisorClock(supervisor, 0, true);
			await advanceSupervisorClock(supervisor, 799, false);
			const peer = await JsonlPeer.connect(qa.socket);
			await peer.request({ id: "readiness", type: "get_protocol_info" });
			const detached = supervisorMessage(supervisor, "detached");
			peer.destroy();
			await detached;
			const result = await advanceSupervisorClock(supervisor, 800, true);
			expect(result).toMatchObject({ shuttingDown: false });
			// Reconnect through the real public endpoint, not a process-liveness probe.
			const next = await JsonlPeer.connect(qa.socket);
			expect(await next.request({ id: "next", type: "get_protocol_info" })).toMatchObject({ success: true });
			const nextDetached = supervisorMessage(supervisor, "detached");
			next.destroy();
			await nextDetached;
			expect(await advanceSupervisorClock(supervisor, 1_599, true)).toMatchObject({ shuttingDown: false });
			expect(await advanceSupervisorClock(supervisor, 1_600, true)).toMatchObject({ shuttingDown: true });
			expect(await exited).toEqual([0, null]);
		} finally {
			supervisor.kill();
			await exited;
		}
	}, 45_000);

	// A status poller must not keep every host it looks at alive (senpi#2245 review M1).
	it("keeps the idle window running across observing status reads", async () => {
		const qa = scratch("observe");
		const { supervisor, exited } = clockSupervisor(qa);
		try {
			await supervisorMessage(supervisor, "ready");
			await advanceSupervisorClock(supervisor, 0, true);
			await advanceSupervisorClock(supervisor, 799, false);
			const peer = await JsonlPeer.connect(qa.socket);
			expect(await peer.request({ id: "info", type: "get_protocol_info", observe: true })).toMatchObject({
				success: true,
			});
			expect(await peer.request({ id: "list", type: "list_sessions", observe: true })).toMatchObject({
				success: true,
			});
			const detached = supervisorMessage(supervisor, "detached");
			peer.destroy();
			await detached;
			expect(await advanceSupervisorClock(supervisor, 800, true)).toMatchObject({ shuttingDown: true });
			expect(await exited).toEqual([0, null]);
		} finally {
			supervisor.kill();
			await exited;
		}
	}, 45_000);

	it("attaches a connection from its first request that is not an observing read", async () => {
		const qa = scratch("obsattach");
		const { supervisor, exited } = clockSupervisor(qa);
		try {
			await supervisorMessage(supervisor, "ready");
			await advanceSupervisorClock(supervisor, 0, true);
			await advanceSupervisorClock(supervisor, 799, false);
			const peer = await JsonlPeer.connect(qa.socket);
			await peer.request({ id: "info", type: "get_protocol_info", observe: true });
			// `observe` on anything but a read does not make it one.
			await peer.request({ id: "commands", type: "get_commands", observe: true });
			const detached = supervisorMessage(supervisor, "detached");
			peer.destroy();
			await detached;
			// The attachment restarted the window when it detached, at 799.
			expect(await advanceSupervisorClock(supervisor, 800, true)).toMatchObject({ shuttingDown: false });
			expect(await advanceSupervisorClock(supervisor, 1_598, true)).toMatchObject({ shuttingDown: false });
			expect(await advanceSupervisorClock(supervisor, 1_599, true)).toMatchObject({ shuttingDown: true });
			expect(await exited).toEqual([0, null]);
		} finally {
			supervisor.kill();
			await exited;
		}
	}, 45_000);

	it("exits cleanly after the idle window with no connections and no active turns", async () => {
		const qa = scratch("idle");
		const ensured = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600 } });
		expect(ensured.reused).toBe(false);
		const entry = currentManaged();
		await waitForHostExit(entry);
		expect(existsSync(entry.pidFilePath)).toBe(false);
		expect(existsSync(daemonPaths(qa).settingsFile)).toBe(false);
		expect(await endpointLive(qa.socket)).toBe(false);
		// Scoped to THIS supervisor: the internal directories live in one shared tmpdir, so any
		// other host running concurrently (another suite, another checkout) owns its own.
		expect(listInternalSocketDirs(ensured.pid)).toEqual([]);
	}, 45_000);

	it("does not exit while a client is attached, then exits after it detaches", async () => {
		const qa = scratch("conn");
		const ensured = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600 }, hold: true });
		const entry = currentManaged();
		const peer = await JsonlPeer.connect(qa.socket);
		ensured.release();
		await delay(2_000);
		await expectHostAlive(qa, entry.pidFile);
		peer.destroy();
		await waitForHostExit(entry);
	}, 45_000);

	it("does not exit while a turn is active even with no connections; exits after the turn settles", async () => {
		const qa = scratch("turn");
		const model = await HeldAnthropicModel.start();
		models.push(model);
		writeRpcModelsJson(qa.agentDir, model.origin);
		const ensured = await ensureLifecycleHost(qa, {
			policy: { idleExitMs: 800 },
			hostArgs: ["--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			hold: true,
		});
		const entry = currentManaged();
		const peer = await JsonlPeer.connect(qa.socket);
		ensured.release();
		const opened = await peer.request({ id: "open", type: "open_session", cwd: qa.cwd });
		const sessionId = openedSessionId(opened);
		const agentStart = peer.waitFor((value) => value.type === "agent_start" && value.sessionId === sessionId);
		await peer.request({ id: "prompt", type: "prompt", sessionId, message: "hold this turn open" });
		await agentStart;
		peer.destroy();
		await delay(2_500);
		await expectHostAlive(qa, entry.pidFile);
		model.release();
		await waitForHostExit(entry, 20_000);
	}, 60_000);

	// senpi#2227: the idle window used to start when ensureHost's readiness probe detached, so a
	// client slower than the window to attach (a loaded runner, a lock release) found no host.
	it("keeps an ensured host up past its idle window until the ensuring client attaches", async () => {
		const qa = scratch("hold");
		const ensured = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600 }, hold: true });
		const entry = currentManaged();
		await delay(2_000);
		const peer = await JsonlPeer.connect(qa.socket);
		expect(await peer.request({ id: "held", type: "get_protocol_info" })).toMatchObject({ success: true });
		ensured.release();
		peer.destroy();
		await waitForHostExit(entry);
	}, 45_000);

	it("starts a fresh host transparently on the next ensure after an idle exit", async () => {
		const qa = scratch("ensure");
		const first = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600 } });
		const entry = currentManaged();
		await waitForHostExit(entry);
		const second = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600 } });
		expect(second.reused).toBe(false);
		expect(second.pid).not.toBe(first.pid);
		const info = await protocolInfo(qa.socket);
		expect(info.data).toMatchObject({ serverVersion: VERSION, mode: "multi" });
	}, 60_000);

	it("persistent cold start never idle-exits (env override beats settings)", async () => {
		const qa = scratch("persist");
		await ensureLifecycleHost(qa, {
			policy: { idleExitMs: 600 },
			env: { [HOST_COLD_START_ENV]: "persistent" },
		});
		const entry = currentManaged();
		await delay(2_500);
		await expectHostAlive(qa, entry.pidFile);
		terminateSupervisor(entry.pidFile.pid, "SIGTERM");
		await waitForHostExit(entry, WINDOWS_SUPERVISOR_EXIT_TIMEOUT_MS);
	}, 45_000);

	it("preserves a live public socket when supervisor startup cannot bind it", async () => {
		const qa = scratch("collision");
		const secret = process.platform === "win32" ? await createSocketSecret(socketSecretPath(qa.socket)) : undefined;
		const live = createServer((socket) => {
			if (secret) authenticateSocket(socket, secret, () => socket.resume());
			else socket.resume();
		});
		await new Promise<void>((resolve) =>
			live.listen(resolveSocketTransportAddress(qa.socket, process.platform, secret), resolve),
		);
		const supervisor = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				hostLifecycleEntry(),
				"--socket",
				qa.socket,
				"--child-command",
				process.execPath,
				"--child-args",
				JSON.stringify(["--import", "tsx", collisionChildFixture]),
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
			supervisor.once("exit", (code, signal) => resolve({ code, signal })),
		);
		expect(exit).toMatchObject({ code: 1 });
		expect(await endpointLive(qa.socket)).toBe(true);
		live.close();
	}, 45_000);

	it("reaps the internal host when the supervisor is SIGKILLed (no catchable-signal path)", async () => {
		const qa = scratch("kill9");
		// A long idle window leaves the supervisor-lifetime binding as the only thing
		// that can reap the internal host during this test.
		const ensured = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600_000 } });
		const entry = currentManaged();
		const internalHosts = await waitForChildPids(ensured.pid);
		expect(internalHosts.length).toBeGreaterThan(0);
		const leakedDirs = listInternalSocketDirs(ensured.pid);
		// The internal host serves a filesystem socket from its own tmp directory on POSIX, so a running
		// supervisor must own at least one. win32 serves a NAMED PIPE instead: there is no directory to
		// create, so the only honest expectation there is that none exists - and the reap assertions
		// below (every internal host gone, nothing left under tmp) still carry the real invariant.
		if (process.platform === "win32") expect(leakedDirs).toEqual([]);
		else expect(leakedDirs.length).toBeGreaterThan(0);

		terminateSupervisor(ensured.pid, "SIGKILL");
		await waitForPidsGone(internalHosts, 10_000);
		expect(internalHosts.filter(processAlive)).toEqual([]);
		expect(leakedDirs.filter((dir) => existsSync(join(tmpdir(), dir)))).toEqual([]);
		expect(await endpointLive(qa.socket)).toBe(false);
		// Win32 endpoint close and metadata unlink are separate operations; poll the
		// identity-aware lifecycle helper instead of asserting the pidfile atomically.
		await waitForHostExit(entry, WINDOWS_SUPERVISOR_EXIT_TIMEOUT_MS);
		expect(existsSync(daemonPaths(qa).settingsFile)).toBe(false);
	}, 60_000);
});

describe("host watchdog configuration", () => {
	it("is inert unless the supervisor asks for a lifetime binding", () => {
		expect(readHostWatchdogConfig({})).toBeUndefined();
		expect(readHostWatchdogConfig({ [HOST_SCRATCH_DIR_ENV]: "/tmp/whatever" })).toBeUndefined();
		expect(readHostWatchdogConfig({ [HOST_WATCH_FD_ENV]: "not-a-number" })).toBeUndefined();
		expect(readHostWatchdogConfig({ [HOST_WATCH_FD_ENV]: "0" })).toBeUndefined();
		let fired = false;
		const disarm = armHostWatchdog(undefined, () => {
			fired = true;
		});
		disarm();
		expect(fired).toBe(false);
	});

	it("reads the fd, ppid and scratch directory the supervisor passes", () => {
		expect(
			readHostWatchdogConfig({
				[HOST_WATCH_FD_ENV]: "3",
				[HOST_WATCH_PPID_ENV]: "4242",
				[HOST_SCRATCH_DIR_ENV]: "/tmp/senpi-rpc-host-internal-abc",
			}),
		).toEqual({ fd: 3, ppid: 4242, scratchDir: "/tmp/senpi-rpc-host-internal-abc" });
	});

	it("ignores an unavailable watchdog fd when the supervisor is still alive", async () => {
		let fired = false;
		const disarm = armHostWatchdog({ fd: 999_999, ppid: process.pid }, () => {
			fired = true;
		});
		await delay(300);
		disarm();
		expect(fired).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"removes supervisor public state on inherited-pipe EOF",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "senpi-hlc-wd-state-"));
			roots.push(dir);
			const socket = join(dir, "rpc.sock");
			const pidFile = join(dir, "host.pid");
			const settings = join(dir, "settings.json");
			for (const path of [socket, pidFile, settings]) writeFileSync(path, "state");

			const fired = await fireWatchdogOnPipeEof({ cleanupPaths: [socket, pidFile, settings] });

			expect(fired.cleanupExists).toEqual([false, false, false]);
			expect(existsSync(socket)).toBe(false);
			expect(existsSync(pidFile)).toBe(false);
			expect(existsSync(settings)).toBe(false);
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"fires on inherited-pipe EOF and removes the supervisor's private directory",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "senpi-hlc-wd-"));
			roots.push(dir);
			const scratchDir = join(dir, "internal");
			mkdirSync(scratchDir, { recursive: true });

			const fired = await fireWatchdogOnPipeEof({ scratchDir });

			expect(fired.reason).toContain("closed");
			expect(existsSync(scratchDir)).toBe(false);
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"runs beforeCleanup while the private directory still exists, then cleans up, then reports",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "senpi-hlc-wd-order-"));
			roots.push(dir);
			const scratchDir = join(dir, "internal");
			mkdirSync(scratchDir, { recursive: true });
			const sidecar = join(scratchDir, "public-socket.owner");
			writeFileSync(sidecar, JSON.stringify({ dev: 1, ino: 2 }));

			const fired = await fireWatchdogOnPipeEof({ scratchDir, sidecar });

			// The host reads its ownership token in beforeCleanup; cleanup must not have
			// destroyed the directory yet, and the shutdown report comes last.
			expect(fired.order).toEqual(["beforeCleanup sidecar=true", "fired scratch=false"]);
		},
		20_000,
	);
});

describe("findInternalSupervisorArgs", () => {
	it("dispatches when the sentinel leads argv", () => {
		expect(findInternalSupervisorArgs([INTERNAL_SUPERVISOR_FLAG, "--socket", "/tmp/qa.sock"])).toEqual([
			"--socket",
			"/tmp/qa.sock",
		]);
	});

	it("dispatches through a rebranded wrapper's injected --extension prefix", () => {
		// packages/omo-native prepends this pair to every non-early command, which
		// is exactly the argv shape that used to miss the route entirely.
		expect(
			findInternalSupervisorArgs([
				"--extension",
				"/opt/branded/plugin",
				INTERNAL_SUPERVISOR_FLAG,
				"--socket",
				"/tmp/qa.sock",
			]),
		).toEqual(["--socket", "/tmp/qa.sock"]);
	});

	it("refuses a sentinel that follows a positional operand", () => {
		expect(
			findInternalSupervisorArgs(["explain this", INTERNAL_SUPERVISOR_FLAG, "--socket", "/tmp/x"]),
		).toBeUndefined();
	});

	it("refuses a sentinel escaped behind --", () => {
		expect(findInternalSupervisorArgs(["--", INTERNAL_SUPERVISOR_FLAG, "--socket", "/tmp/x"])).toBeUndefined();
	});

	it("refuses a sentinel behind an unknown flag", () => {
		expect(findInternalSupervisorArgs(["--print", INTERNAL_SUPERVISOR_FLAG])).toBeUndefined();
	});

	it("refuses a dangling prefix flag with no value", () => {
		expect(findInternalSupervisorArgs(["--extension"])).toBeUndefined();
	});

	it("returns undefined when the sentinel is absent", () => {
		expect(findInternalSupervisorArgs(["--mode", "rpc"])).toBeUndefined();
	});
});

describe("resolveHostChildLaunch", () => {
	const baseLaunch = { socket: "/tmp/qa-public.sock", hostArgs: ["--provider", "mock"] } as const;

	it("forwards explicit child commands untouched", () => {
		const launch = { ...baseLaunch, childCommand: "/opt/branded/omo", childArgs: ["--mode", "rpc"] };
		expect(resolveHostChildLaunch(launch, "/tmp/internal.sock", true)).toEqual({
			command: "/opt/branded/omo",
			args: ["--mode", "rpc", "--listen", "unix:///tmp/internal.sock"],
		});
	});

	it("quotes cmd launchers before adding shell metacharacter escaping", () => {
		const launch = spawnableChildLaunch(
			{ command: "C:\\Program Files\\launcher.cmd", args: ["hello world", "x&y"] },
			"win32",
		);
		expect(launch.shell).toBe(true);
		expect(launch.command).toBe('"C:\\Program Files\\launcher.cmd"');
		expect(launch.args).toEqual(['"hello world"', '"x^&y"']);
	});

	it("passes the mode flags directly to the executable in compiled binaries", () => {
		expect(resolveHostChildLaunch(baseLaunch, "/tmp/internal.sock", true)).toEqual({
			command: process.execPath,
			args: ["--mode", "rpc", "--multi-session", "--listen", "unix:///tmp/internal.sock", "--provider", "mock"],
		});
	});

	it("re-enters the committed CLI entry outside compiled binaries", () => {
		const launch = resolveHostChildLaunch(baseLaunch, "/tmp/internal.sock", false);
		expect(launch.command).toBe(process.execPath);
		const args = launch.args.slice(process.execArgv.length);
		expect(args[0]).toMatch(/cli-main\.(ts|js)$/);
		expect(args.slice(1)).toEqual([
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			"unix:///tmp/internal.sock",
			"--provider",
			"mock",
		]);
	});
});

async function supervisorMessage(supervisor: ChildProcess, type: string): Promise<RecordValue> {
	for await (const values of on(supervisor, "message", { signal: AbortSignal.timeout(30_000) })) {
		const message: unknown = values[0];
		if (typeof message === "object" && message !== null && "type" in message && message.type === type) return message;
	}
	throw new Error(`supervisor closed before ${type}`);
}

/** The real supervisor on a test-driven clock (`fixtures/rpc-lifecycle-clock.ts`), idle window 800 ms. */
function clockSupervisor(qa: Scratch): { supervisor: ChildProcess; exited: Promise<unknown[]> } {
	const supervisor = spawn(
		process.execPath,
		["--import", "tsx", join(import.meta.dirname, "fixtures", "rpc-lifecycle-clock.ts"), qa.socket, qa.agentDir],
		{
			env: {
				...process.env,
				...hermeticProviderEnv(),
				SENPI_CODING_AGENT_DIR: qa.agentDir,
				SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
				[HOST_IDLE_EXIT_MS_ENV]: "800",
			},
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		},
	);
	return { supervisor, exited: once(supervisor, "exit", { signal: AbortSignal.timeout(30_000) }) };
}

function advanceSupervisorClock(supervisor: ChildProcess, now: number, tick: boolean): Promise<RecordValue> {
	const advanced = supervisorMessage(supervisor, "clock");
	supervisor.send({ now, tick });
	return advanced;
}

function scratch(label: string): Scratch {
	// Unix socket paths must stay under the platform sun_path limit (104 bytes on
	// macOS), so the scratch prefix and labels are kept deliberately short.
	const root = mkdtempSync(join(tmpdir(), `senpi-hlc-${label}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return {
		root,
		agentDir,
		sessionDir,
		cwd,
		socket: join(root, "rpc.sock"),
		pidFilePath: daemonPaths({ agentDir, socket: join(root, "rpc.sock") }).pointerFile,
	};
}

/**
 * The private internal-socket directories owned by ONE supervisor. The directories all live in the
 * shared tmpdir, so "everything that appeared during this test" would also count the hosts other
 * suites (or another checkout) started meanwhile; each directory's `.owner` names its supervisor.
 */
function listInternalSocketDirs(ownerPid: number): string[] {
	return readdirSync(tmpdir())
		.filter((name) => name.startsWith("senpi-rpc-host-internal-"))
		.filter((name) => {
			try {
				const owner = JSON.parse(readFileSync(join(tmpdir(), name, ".owner"), "utf8")) as { pid?: unknown };
				return owner.pid === ownerPid;
			} catch {
				// A directory whose owner cannot be read is not this supervisor's to claim.
				return false;
			}
		});
}

/** Direct children of `pid`. `pgrep` is POSIX-only, so Windows queries CIM. */
function readChildPids(pid: number): number[] {
	const command =
		process.platform === "win32"
			? {
					executable: "powershell.exe",
					args: [
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(pid)}" | ForEach-Object { $_.ProcessId }`,
					],
				}
			: { executable: "pgrep", args: ["-P", String(pid)] };
	let output = "";
	try {
		output = execFileSync(command.executable, command.args, { encoding: "utf8", windowsHide: true });
	} catch {
		output = "";
	}
	return output
		.split("\n")
		.map((value) => Number(value.trim()))
		.filter((value) => Number.isInteger(value) && value > 0);
}

async function waitForChildPids(pid: number, timeoutMs = 10_000): Promise<number[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const children = readChildPids(pid);
		if (children.length > 0) return children;
		await delay(100);
	}
	return [];
}

/**
 * Whether the public endpoint still accepts a connection. A Windows named pipe
 * is not a filesystem entry, so `existsSync` on the logical socket path can
 * never observe it; connectability is the contract on both platforms.
 */
async function endpointLive(socketPath: string): Promise<boolean> {
	const secret = process.platform === "win32" ? await readSocketSecret(socketSecretPath(socketPath)) : undefined;
	return new Promise((resolve) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		if (secret) sendSocketHandshake(socket, secret);
		const settle = (live: boolean): void => {
			socket.destroy();
			resolve(live);
		};
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
		socket.setTimeout(1_000, () => settle(false));
	});
}

async function waitForPidsGone(pids: readonly number[], timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (!pids.some(processAlive)) return;
		await delay(100);
	}
}

function hostLifecycleEntry(): string {
	return join(import.meta.dirname, "..", "src", "modes", "rpc", "host-lifecycle.ts");
}

interface WatchdogFiring {
	readonly reason: string;
	readonly scratchExists: boolean;
	readonly cleanupExists: readonly boolean[];
	readonly order: readonly string[];
}

/**
 * Arms the watchdog in a child process over a REAL inherited pipe on fd 3 - the binding the
 * supervisor creates - and closes the write end, which is exactly what the supervisor's death
 * looks like to the host. Resolves with what the child observed when it fired.
 */
async function fireWatchdogOnPipeEof(options: {
	scratchDir?: string;
	cleanupPaths?: readonly string[];
	sidecar?: string;
}): Promise<WatchdogFiring> {
	const child = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "fixtures", "rpc-watchdog-pipe.ts"),
			options.scratchDir ?? "",
			...(options.cleanupPaths ?? []),
		],
		{
			env: { ...process.env, ...(options.sidecar ? { WATCHDOG_SIDECAR: options.sidecar } : {}) },
			stdio: ["ignore", "ignore", "inherit", "pipe", "ipc"],
		},
	);
	const order: string[] = [];
	try {
		const fired = new Promise<WatchdogFiring>((resolve, reject) => {
			child.on("message", (message: RecordValue) => {
				if (message.type === "armed") {
					// Closing our end of the pipe is the supervisor's death, seen from the host.
					child.stdio[3]?.destroy();
					return;
				}
				if (message.type === "beforeCleanup") {
					order.push(`beforeCleanup sidecar=${String(message.sidecarExists)}`);
					return;
				}
				if (message.type !== "fired") return;
				order.push(`fired scratch=${String(message.scratchExists)}`);
				resolve({
					reason: String(message.reason),
					scratchExists: message.scratchExists === true,
					cleanupExists: Array.isArray(message.cleanupExists) ? (message.cleanupExists as boolean[]) : [],
					order,
				});
			});
			child.once("exit", (code) => reject(new Error(`watchdog fixture exited (${code}) before firing`)));
			child.once("error", reject);
		});
		return await fired;
	} finally {
		child.removeAllListeners("exit");
		child.kill("SIGKILL");
	}
}

async function ensureLifecycleHost(
	qa: Scratch,
	options: {
		policy?: HostLifecyclePolicyInput;
		hostArgs?: string[];
		env?: Record<string, string>;
		spawn?: { command: string; args: string[] };
		/** Keep the ensure's attach hold; the test releases it once its own client is attached. */
		hold?: boolean;
	} = {},
) {
	const hostArgs = options.hostArgs ?? [];
	try {
		const ensured = await ensureHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			policy: options.policy,
			hostArgs,
			env: {
				...hermeticProviderEnv(),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				SENPI_RUNTIME: "node",
				SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
				...(options.env ?? {}),
			},
			_test: {
				readinessTimeoutMs: 30_000,
				spawn: options.spawn
					? {
							command: process.execPath,
							args: [
								hostLifecycleEntry(),
								"--socket",
								qa.socket,
								"--child-command",
								options.spawn.command,
								"--child-args",
								JSON.stringify(options.spawn.args),
							],
						}
					: { command: process.execPath, args: [hostLifecycleEntry(), "--socket", qa.socket, ...hostArgs] },
			},
		});
		if (!options.hold) ensured.release();
		managed.push({ pidFile: await recordedPidFile(qa, ensured.pid), pidFilePath: qa.pidFilePath });
		return ensured;
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\n[supervisor stderr]\n${readSupervisorStderr(qa)}`,
		);
	}
}

/**
 * The transient supervisor can idle-exit between answering the handshake and
 * ensureHost returning, so the pidfile may already be gone; the returned pid is
 * still the identity every later liveness/exit probe needs.
 */
async function recordedPidFile(qa: Scratch, pid: number): Promise<{ pid: number; processStartTime: string }> {
	const record = (await readHostRegistration(daemonPaths(qa)).catch(() => undefined))?.record;
	return record?.processStartTime !== undefined && record.processStartTime !== null
		? { pid: record.pid, processStartTime: record.processStartTime }
		: { pid, processStartTime: (await readProcessStartTime(pid)) ?? "" };
}

/** This endpoint's daemon directory: one per socket, so the agent directory alone no longer names it. */
function daemonPaths(qa: { readonly agentDir: string; readonly socket: string }) {
	return createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
}

function readSupervisorStderr(qa: Scratch): string {
	try {
		return readFileSync(daemonPaths(qa).stderrLog, "utf8");
	} catch {
		return "<no supervisor stderr log>";
	}
}

function currentManaged(): { pidFile: { pid: number; processStartTime: string }; pidFilePath: string } {
	const entry = managed.at(-1);
	if (!entry) throw new Error("no managed host for this test");
	return entry;
}

/**
 * Liveness assertions must not fail on a flaky identity probe: the Windows CIM
 * query is a 1s-bounded PowerShell that can throw (timeout) or report a live
 * pid as ABSENT for one read while the process is alive (issue #1290 variant 2
 * hit both shapes on CI - the production callers got throw-retry in 1640d9b67,
 * and PR #1291's own CI run then proved a lone false read occurs too). Treat
 * "alive" as decisive on the first read, and require two consecutive agreeing
 * "not alive" reads before reporting dead; a genuinely dead host settles in one
 * extra 500ms probe, while a transient miss cannot fail an assertion.
 */
/**
 * Asserts liveness with the supervisor's own stderr attached: when the probe
 * (now double-checked) still reports the host gone, the next CI failure must
 * show WHY - a genuine early exit logs "idle shutdown"/signal lines, while a
 * silent log with a dead pid points at process death, and a live-looking log
 * points at the CIM observer (#1290).
 */
async function expectHostAlive(qa: Scratch, pidFile: { pid: number; processStartTime: string }): Promise<void> {
	const alive = await hostAlive(pidFile);
	if (!alive) throw new Error(`host ${pidFile.pid} reported dead\n[supervisor stderr]\n${readSupervisorStderr(qa)}`);
}

async function hostAlive(pidFile: { pid: number; processStartTime: string }): Promise<boolean> {
	const deadline = Date.now() + 10_000;
	let consecutiveNotAlive = 0;
	for (;;) {
		try {
			if (await processMatchesPidFile(pidFile, readProcessStartTime)) return true;
			consecutiveNotAlive += 1;
			if (consecutiveNotAlive >= 2 || Date.now() > deadline) return false;
		} catch (cause) {
			consecutiveNotAlive = 0;
			if (Date.now() > deadline) throw cause;
		}
		await delay(500);
	}
}

async function waitForHostExit(
	entry: { pidFile: { pid: number; processStartTime: string }; pidFilePath: string },
	timeoutMs = 12_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		let currentIdentity: string | undefined;
		let probeTimedOut = false;
		if (process.platform === "win32") {
			// Serialize the Windows CIM query: one bounded PowerShell probe at a time
			// avoids the 50ms polling storm that caused every probe to time out.
			const probe = probeWindowsProcessIdentity(entry.pidFile.pid, 10_000);
			currentIdentity = probe.identity;
			// A probe that timed out reports UNKNOWN, not ALIVE. kill(pid, 0) answers
			// liveness deterministically, so a host that really exited is recognized here
			// instead of spinning until the deadline and failing with "did not exit".
			probeTimedOut = probe.timedOut && processIsLive(entry.pidFile.pid);
		} else {
			currentIdentity = await readProcessStartTime(entry.pidFile.pid);
		}
		if (currentIdentity === entry.pidFile.processStartTime) {
			await delay(process.platform === "win32" ? 1_000 : 50);
			continue;
		}
		if (!probeTimedOut) {
			if (!existsSync(entry.pidFilePath)) return;
			// Force-kill teardown can leave a stale pidfile after the recorded process
			// is already gone and the endpoint is no longer connectable. A nonmatching
			// identity is the test's live-CIM stale-state proof,
			// not a raw PID-liveness guess. File deletion and process death are not
			// atomic; remove the stale state before the next lifecycle scenario.
			rmSync(entry.pidFilePath, { force: true });
			rmSync(join(dirname(entry.pidFilePath), "settings.json"), { force: true });
			return;
		}
		await delay(1_000);
	}
	throw new Error(`RPC socket host pid ${entry.pidFile.pid} did not exit within ${timeoutMs}ms`);
}

function probeWindowsProcessIdentity(pid: number, timeoutMs: number): { identity?: string; timedOut: boolean } {
	const command = `$process = Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" -ErrorAction Stop; if ($null -eq $process) { exit 1 }; $process.CreationDate.ToFileTimeUtc().ToString("D", [Globalization.CultureInfo]::InvariantCulture)`;
	try {
		const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
			encoding: "utf8",
			windowsHide: true,
			timeout: timeoutMs,
		});
		return { identity: output.trim() || undefined, timedOut: false };
	} catch (cause) {
		const error = cause as { code?: unknown; killed?: unknown; signal?: unknown };
		return {
			identity: undefined,
			timedOut: error.code === "ETIMEDOUT" || error.killed === true || error.signal === "SIGTERM",
		};
	}
}

async function stopHostProcess(pidFile: { pid: number; processStartTime: string }, pidFilePath: string): Promise<void> {
	try {
		// Teardown must not spend hostAlive()'s assertion-grade retry window: one
		// probe decides, and an unreadable identity is treated as alive so the stop
		// path still runs (stopping an already-dead pid is harmless downstream).
		const alive = await processMatchesPidFile(pidFile, readProcessStartTime).catch(() => true);
		if (alive) {
			if (process.platform === "win32") {
				// Detached Win32 supervisors require Stop-Process; process.kill does not
				// reliably terminate them and can leak handles into the next test.
				terminateSupervisor(pidFile.pid, "SIGTERM");
				await waitForHostExit({ pidFile, pidFilePath }, WINDOWS_SUPERVISOR_EXIT_TIMEOUT_MS).catch(async () => {
					terminateSupervisor(pidFile.pid, "SIGKILL");
					await waitForHostExit({ pidFile, pidFilePath }, 2_000).catch(() => undefined);
				});
			} else {
				signalIfAlive(pidFile.pid, "SIGTERM");
				await waitForHostExit({ pidFile, pidFilePath }, 5_000).catch(async () => {
					// A host that idle-exits on its own between the SIGTERM and this
					// escalation is a normal teardown, not a failure: signal only if the
					// pid is still ours, so teardown can never fail with ESRCH.
					signalIfAlive(pidFile.pid, "SIGKILL");
					await waitForHostExit({ pidFile, pidFilePath }, 2_000).catch(() => undefined);
				});
			}
		}
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

function terminateSupervisor(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		// Bun cannot deliver catchable POSIX signals to detached Windows processes.
		// taskkill is the real Windows termination primitive; the child watchdog must
		// still perform the cleanup assertions below when this bypasses JS handlers.
		try {
			execFileSync(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${String(pid)} -Force`],
				{ stdio: "ignore", windowsHide: true },
			);
		} catch (cause) {
			// The supervisor idle-exits on its own timer, so it can vanish between the
			// caller's liveness check and this Stop-Process: an already-gone pid is the
			// outcome the caller wanted, not a failure.
			//
			// Liveness is decided by kill(pid, 0), not by the PowerShell CIM probe: that
			// probe has its own timeout, and a loaded runner hitting it reported
			// `timedOut` for a process that had genuinely exited, which rethrew and made
			// teardown fail on runner slowness alone. A timeout means UNKNOWN, never ALIVE.
			if (!processIsLive(pid)) return;
			throw cause;
		}
		return;
	}
	process.kill(pid, signal);
}

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
}

function openedSessionId(response: RecordValue): string {
	const data = response.data as RecordValue | undefined;
	if (typeof data?.sessionId !== "string")
		throw new Error(`open_session missing session id: ${JSON.stringify(response)}`);
	return data.sessionId;
}

async function protocolInfo(socketPath: string): Promise<RecordValue> {
	const secret = process.platform === "win32" ? await readSocketSecret(socketSecretPath(socketPath)) : undefined;
	return new Promise((resolve, reject) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		let buffer = "";
		const timer = setTimeout(() => finish(new Error("protocol info timeout")), 5_000);
		const finish = (error?: Error, value?: RecordValue) => {
			clearTimeout(timer);
			socket.destroy();
			if (error || value === undefined) reject(error ?? new Error("no protocol info"));
			else resolve(value);
		};
		socket.once("connect", () => {
			if (secret) sendSocketHandshake(socket, secret);
			socket.write('{"id":"probe","type":"get_protocol_info"}\n');
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline !== -1) finish(undefined, JSON.parse(buffer.slice(0, newline)) as RecordValue);
		});
		socket.once("error", finish);
	});
}

class JsonlPeer {
	readonly messages: RecordValue[] = [];
	private buffer = "";
	private readonly socket: Socket;
	private readonly waiters = new Set<{
		predicate: (value: RecordValue) => boolean;
		resolve: (value: RecordValue) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk) => this.read(chunk.toString("utf8")));
	}

	static async connect(socketPath: string): Promise<JsonlPeer> {
		const secret = process.platform === "win32" ? await readSocketSecret(socketSecretPath(socketPath)) : undefined;
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		if (secret) sendSocketHandshake(socket, secret);
		const peer = new JsonlPeer(socket);
		peers.push(peer);
		return peer;
	}

	request(command: RecordValue, timeoutMs = 15_000): Promise<RecordValue> {
		const id = command.id;
		const response = this.waitFor((value) => value.type === "response" && value.id === id, timeoutMs);
		this.write(command);
		return response;
	}

	write(value: unknown): void {
		this.socket.write(`${JSON.stringify(value)}\n`);
	}

	waitFor(predicate: (value: RecordValue) => boolean, timeoutMs = 15_000): Promise<RecordValue> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error("Timed out waiting for RPC record"));
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
	}

	destroy(): void {
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve({ type: "peer-closed" });
		}
		this.waiters.clear();
		this.socket.destroy();
	}

	private read(text: string): void {
		this.buffer += text;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line) as RecordValue;
			this.messages.push(message);
			for (const waiter of [...this.waiters]) {
				if (!waiter.predicate(message)) continue;
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				waiter.resolve(message);
			}
		}
	}
}

/**
 * Anthropic-Messages fake whose single response is held until release(), so a
 * real agent turn stays active past any idle window under test.
 */
class HeldAnthropicModel {
	private readonly server: HttpServer;
	private readonly releaseHolds: () => void;

	private constructor(server: HttpServer, releaseHolds: () => void) {
		this.server = server;
		this.releaseHolds = releaseHolds;
	}

	static async start(): Promise<HeldAnthropicModel> {
		let releaseHolds: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			releaseHolds = resolve;
		});
		const server = createHttpServer((req, res) => {
			req.resume();
			req.on("end", () => {
				void held.then(() => writeHeldAnthropicResponse(res));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return new HeldAnthropicModel(server, releaseHolds);
	}

	get origin(): string {
		const address = this.server.address() as AddressInfo;
		return `http://127.0.0.1:${address.port}`;
	}

	release(): void {
		this.releaseHolds();
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}
}

function writeHeldAnthropicResponse(res: ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const send = (event: string, data: Record<string, unknown>): void => {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
	};
	send("message_start", {
		message: {
			id: "msg-held-rpc",
			type: "message",
			role: "assistant",
			model: MOCK_MODEL,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	});
	send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "held turn complete" } });
	send("content_block_stop", { index: 0 });
	send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
	send("message_stop", {});
	res.end();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
