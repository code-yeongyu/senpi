import { ChildProcess } from "node:child_process";
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
import { CHILD_KILL_EXIT_TIMEOUT_MS } from "../../../src/modes/rpc/host-stop-intent.ts";

interface ShutdownRig {
	readonly root: string;
	readonly generation: HostGenerationPaths;
	readonly child: ChildProcess;
	readonly exitProcess: ReturnType<typeof vi.spyOn>;
	/** Signals the shutdown asked for, in call order. */
	readonly signals: readonly string[];
	/** The `process.kill` seam `signalChild` calls: every call, with its pid. */
	readonly kill: ReturnType<typeof vi.spyOn>;
	/** Fake-clock time of the SIGKILL and of the supervisor's exit (NaN until each happens). */
	readonly clock: { readonly sigkillAt: number; readonly exitAt: number };
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
	// #6657: the child is a `ChildProcess` stand-in, not a real process. A real child's exit
	// arrived on the real event loop and raced the fake 30 s kill-exit bound, so a loaded host
	// failed this test with the code under test correct. The stand-in replaces only the
	// process: shutdown still signals it through its real seam (`signalChild` ->
	// `process.kill`, stubbed below) and observes its end through `waitForChildExit`'s real
	// `exit` listener. Production spawns the host child in `host-lifecycle-launch.ts`, which is
	// not on this shutdown path. The pid is never delivered to the OS.
	const child = new ChildProcess();
	const childPid = 2_147_483_647;
	(child as { pid: number | undefined }).pid = childPid;
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
	const clock = { sigkillAt: Number.NaN, exitAt: Number.NaN };
	const exitProcess = vi.spyOn(process, "exit").mockImplementation(() => {
		clock.exitAt = Date.now();
		throw exit;
	});
	// Record every signal the shutdown asks for, in order: the SIGTERM grace step is
	// only observable here — the child is reaped by SIGKILL either way. No signal reaches
	// the OS. The child ignores SIGTERM; SIGKILL ends it, and its exit is delivered on the
	// next microtask: after `waitForChildExit` has subscribed (it is called synchronously
	// after the signal) and before any fake time can advance toward the kill-exit bound.
	const signals: string[] = [];
	const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		signals.push(typeof signal === "string" ? signal : "SIGTERM");
		if (pid !== childPid || signal !== "SIGKILL") return true;
		clock.sigkillAt = Date.now();
		queueMicrotask(() => {
			(child as { signalCode: NodeJS.Signals | null }).signalCode = "SIGKILL";
			child.emit("exit", null, "SIGKILL");
		});
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
		kill,
		clock,
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
			vi.useRealTimers();
			vi.restoreAllMocks();
			activity.stopObserver();
			await rm(root, { recursive: true, force: true });
		},
	};
}

// Captured before any test fakes the timers: shutdown's file I/O (the stop intent, the
// generation) completes on the real event loop, which fake-timer advances alone never turn.
const realSetTimeout = setTimeout;

/**
 * Advance fake time in small steps, yielding to the real loop after each step, until the
 * awaited shutdown settles — or the bound is hit. The bound is on fake time advanced, not
 * on a fixed step count: the loop stops as soon as the promise settles, and the small steps
 * let the real loop finish shutdown's file I/O between fake-time steps.
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
		// Let the real loop finish shutdown's file I/O before fake time moves on.
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

/** The stop drove the real seam (`signalChild` -> `process.kill`) at the child's pid, and nothing else. */
function expectSignalledAtSeam(rig: ShutdownRig): void {
	expect(rig.kill.mock.calls).toEqual([
		[rig.child.pid, "SIGTERM"],
		[rig.child.pid, "SIGKILL"],
	]);
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
		expectSignalledAtSeam(rig);
		expect(rig.child.signalCode).toBe("SIGKILL");
		// #6657 follow-up: the recovery's SIGKILL wait OBSERVED the exit through
		// `waitForChildExit`'s listener, so shutdown ended before the kill-exit breaker could
		// fire. An unobserved exit is swallowed by the recovery and ends shutdown only after
		// the full bound, with the same signals and calls as above.
		expect(rig.clock.exitAt - rig.clock.sigkillAt).toBeLessThan(CHILD_KILL_EXIT_TIMEOUT_MS);
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
		expectSignalledAtSeam(rig);
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
		expectSignalledAtSeam(rig);
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
