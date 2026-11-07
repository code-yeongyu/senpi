import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HostAdmission } from "../../../src/modes/rpc/host-admission.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	generationPaths,
	type HostGenerationPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { SupervisorActivity } from "../../../src/modes/rpc/host-lifecycle-activity.ts";
import { SupervisorDrain } from "../../../src/modes/rpc/host-lifecycle-drain.ts";
import { performShutdown, type SupervisorState } from "../../../src/modes/rpc/host-lifecycle-shutdown.ts";

interface ShutdownRig {
	readonly root: string;
	readonly generation: HostGenerationPaths;
	readonly child: ChildProcess;
	readonly exitProcess: ReturnType<typeof vi.spyOn>;
	/** Signals the shutdown asked for, in call order. */
	readonly signals: readonly string[];
	readonly drainStop: ReturnType<typeof vi.spyOn>;
	readonly stopWatchers: ReturnType<typeof vi.fn>;
	readonly flushAdmission: ReturnType<typeof vi.spyOn>;
	readonly destroyAll: ReturnType<typeof vi.spyOn>;
	readonly stopped: Promise<"exited">;
	readonly cleanup: () => Promise<void>;
}

async function startShutdown(options: {
	readonly throwFrom: "drain" | "stopWatchers" | "destroyAll";
}): Promise<ShutdownRig> {
	const root = await mkdtemp(join(tmpdir(), "shutdown-call-sites-"));
	const paths = createHostDaemonPaths({ socket: join(root, "rpc.sock"), agentDir: root });
	const generation = generationPaths(paths, "shutdown-call-sites");
	await createDaemonDirectories(paths);
	await writeHostRegistration(paths, {
		record: { pid: process.pid, processStartTime: null },
		socket: paths.socket,
		instanceId: "shutdown-call-sites",
		generation: 0,
		launchProfileId: "shutdown-call-sites-test",
	});
	// The child ignores SIGTERM, so the stop escalates to SIGKILL before it is reaped.
	// `process.kill` is stubbed below: the SIGTERM call is recorded but never delivered,
	// so no readiness handshake is needed (nothing can kill the child before its handler
	// is installed), while the SIGKILL is delivered for real and reaps the child.
	const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000);"]);
	if (child.pid === undefined) throw new Error("shutdown child has no pid");
	let resolveChildExit!: () => void;
	const childExitRecorded = new Promise<void>((resolve) => {
		resolveChildExit = resolve;
	});
	child.once("exit", () => resolveChildExit());
	const state: SupervisorState = {
		shuttingDown: false,
		shutdownReason: undefined,
		childExitRecorded,
		startupComplete: Promise.resolve(),
		publicSocketOwned: false,
		publicSocketIdentity: undefined,
		endpointReplaced: false,
	};
	const activity = new SupervisorActivity({
		idleExitMs: Infinity,
		internalSocket: join(root, "internal.sock"),
		instanceId: "shutdown-call-sites",
		settled: () => state.shuttingDown,
	});
	const drain = new SupervisorDrain(child, () => state.shuttingDown);
	const drainStop = vi.spyOn(drain, "stop");
	if (options.throwFrom === "drain")
		drainStop.mockImplementation(() => {
			throw new Error("drain stop failed");
		});
	const destroyAll = vi.spyOn(activity.clients, "destroyAll");
	if (options.throwFrom === "destroyAll")
		destroyAll.mockImplementation(() => {
			throw new Error("destroy clients failed");
		});
	const stopWatchers = vi.fn(() => {
		if (options.throwFrom === "stopWatchers") throw new Error("stop watchers failed");
	});
	const admission = new HostAdmission({
		protocolVersion: 1,
		serverVersion: "test",
		capabilities: [],
		instanceId: "shutdown-call-sites",
	});
	const flushAdmission = vi.spyOn(admission, "flush");
	const exit = new Error("observed supervisor exit");
	const exitProcess = vi.spyOn(process, "exit").mockImplementation(() => {
		throw exit;
	});
	// Record every signal the shutdown asks for, in order: the SIGTERM grace step is
	// only observable here — the child is reaped by SIGKILL either way. Swallow SIGTERM
	// (the child ignores it) and deliver SIGKILL for real so the child is reaped.
	const realKill = process.kill.bind(process);
	const signals: string[] = [];
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		signals.push(typeof signal === "string" ? signal : "SIGTERM");
		if (signal === "SIGKILL") return realKill(pid, signal);
		return true;
	});
	vi.useFakeTimers();
	const stopped = performShutdown(
		{
			paths,
			generation,
			instanceId: "shutdown-call-sites",
			publicSocket: paths.socket,
			server: createServer(),
			internalDir: undefined,
			child,
			activity,
			drain,
			admission,
			state,
			stopWatchers,
		},
		"signal:SIGTERM",
		143,
	).catch((cause: unknown) => {
		if (cause !== exit) throw cause;
		return "exited" as const;
	});
	return {
		root,
		generation,
		child,
		exitProcess,
		signals,
		drainStop,
		stopWatchers,
		flushAdmission,
		destroyAll,
		stopped,
		cleanup: async () => {
			// Let an in-flight shutdown settle first, on the promise rather than a fixed
			// real-time race: the old 5 s race could remove the generation directory
			// while shutdown was still using it. Never let a cleanup failure mask the
			// test's own error.
			await settle(stopped).catch(() => undefined);
			if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
				try {
					realKill(child.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
				await settle(stopped).catch(() => undefined);
			}
			vi.useRealTimers();
			vi.restoreAllMocks();
			activity.stopObserver();
			await rm(root, { recursive: true, force: true });
		},
	};
}

// Captured before any test fakes the timers: the child is a real process, and its exit
// event is delivered on the real event loop, which fake-timer advances alone never turn.
const realSetTimeout = setTimeout;

/**
 * Advance fake time in small steps, yielding to the real loop after each step, until the
 * awaited shutdown settles — or the bound is hit. The bound is on fake time advanced, not
 * on a fixed step count: the loop stops as soon as the promise settles, and the small steps
 * let the real loop deliver the child's exit long before the 30 s kill-exit bound can fire.
 */
async function settle(stopped: Promise<"exited">): Promise<void> {
	let settled = false;
	void stopped.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	const maxFakeMs = 60_000;
	for (let advanced = 0; advanced < maxFakeMs && !settled; advanced += 100) {
		await vi.advanceTimersByTimeAsync(100);
		// Let the real loop deliver the child's exit: without this turn, the mocked
		// 30 s kill wait fires before the SIGKILLed child's exit is observed.
		await new Promise<void>((resolve) => {
			realSetTimeout(resolve, 0);
		});
	}
	if (!settled) throw new Error(`shutdown did not settle after ${maxFakeMs}ms of fake time`);
	await expect(stopped).resolves.toBe("exited");
}

/** The stop intent the ordinary child stop wrote before signalling the child. */
async function expectStopIntent(rig: ShutdownRig): Promise<void> {
	const intent = JSON.parse(await readFile(rig.generation.stopIntentFile, "utf8")) as {
		reason: string;
		signal: string;
		targetPid: number;
	};
	expect(intent.reason).toBe("signal:SIGTERM");
	expect(intent.signal).toBe("SIGTERM");
	expect(intent.targetPid).toBe(rig.child.pid);
}

// #3067 L5: the `!childStopStarted` path in `performShutdown` isn't covered — one test
// per call site, each showing the stop asks for SIGTERM, then SIGKILL, in that order, and
// the child is reaped. The generation is left intact on this path by design (an unobserved
// child exit leaves its generation, pointer and settings intact), and shutdown still exits 1.
// The call-site spies pin where the failure aborted the sequence, so a regression at one
// call site fails its own test instead of only failing on regressions all three share; the
// stop intent further separates the recovery reap (drain: no intent is written, the reap
// sends the signals) from the ordinary child stop (stopWatchers / destroyAll: the intent
// names the stop that already reaped the child).
// Note: stopWatchers and destroyAll run after the ordinary child stop, so by the time
// either throws the child is already dead and the catch block's recovery reap
// (`!childStopStarted`) cannot run for them — no setup can make their own call site drive
// that reap without reordering `performShutdown` itself. These tests pin each call site's
// place in the failure sequence instead.
it("reaps the child when drain.stop throws before the child is signalled", async () => {
	const rig = await startShutdown({ throwFrom: "drain" });
	try {
		await settle(rig.stopped);
		await expect(rig.stopped).resolves.toBe("exited");
		expect(rig.exitProcess).toHaveBeenCalledWith(1);
		// The recovery reap sends SIGTERM first, then SIGKILL: skipping the grace
		// step would record only SIGKILL here.
		expect(rig.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(rig.child.signalCode).toBe("SIGKILL");
		// The failure aborted shutdown before the child stop, so no later step ran
		// and no stop intent was written: the recovery reap drove the signals.
		expect(rig.drainStop).toHaveBeenCalledTimes(1);
		expect(rig.stopWatchers).not.toHaveBeenCalled();
		expect(rig.flushAdmission).not.toHaveBeenCalled();
		expect(rig.destroyAll).not.toHaveBeenCalled();
		await expect(access(rig.generation.stopIntentFile)).rejects.toThrow();
		await expect(access(rig.generation.dir)).resolves.toBeUndefined();
	} finally {
		await rig.cleanup();
	}
});

it("reaps the child when stopWatchers throws after the child stop", async () => {
	const rig = await startShutdown({ throwFrom: "stopWatchers" });
	try {
		await settle(rig.stopped);
		await expect(rig.stopped).resolves.toBe("exited");
		expect(rig.exitProcess).toHaveBeenCalledWith(1);
		expect(rig.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(rig.child.signalCode).toBe("SIGKILL");
		// The child stop already reaped the child (and wrote the stop intent) before
		// stopWatchers threw, so the failure aborted shutdown here: no later step ran.
		expect(rig.drainStop).toHaveBeenCalledTimes(1);
		expect(rig.stopWatchers).toHaveBeenCalledTimes(1);
		expect(rig.flushAdmission).not.toHaveBeenCalled();
		expect(rig.destroyAll).not.toHaveBeenCalled();
		await expectStopIntent(rig);
		await expect(access(rig.generation.dir)).resolves.toBeUndefined();
	} finally {
		await rig.cleanup();
	}
});

it("reaps the child when destroyAll throws after the child stop", async () => {
	const rig = await startShutdown({ throwFrom: "destroyAll" });
	try {
		await settle(rig.stopped);
		await expect(rig.stopped).resolves.toBe("exited");
		expect(rig.exitProcess).toHaveBeenCalledWith(1);
		expect(rig.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(rig.child.signalCode).toBe("SIGKILL");
		// The failure aborted shutdown at the last fallible step: the child stop,
		// stopWatchers and the admission flush all ran before it.
		expect(rig.drainStop).toHaveBeenCalledTimes(1);
		expect(rig.stopWatchers).toHaveBeenCalledTimes(1);
		expect(rig.flushAdmission).toHaveBeenCalledTimes(1);
		expect(rig.destroyAll).toHaveBeenCalledTimes(1);
		await expectStopIntent(rig);
		await expect(access(rig.generation.dir)).resolves.toBeUndefined();
	} finally {
		await rig.cleanup();
	}
});
