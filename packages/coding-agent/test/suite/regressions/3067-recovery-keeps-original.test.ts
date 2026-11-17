import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HostAdmission } from "../../../src/modes/rpc/host-admission.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	generationPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { SupervisorActivity } from "../../../src/modes/rpc/host-lifecycle-activity.ts";
import { SupervisorDrain } from "../../../src/modes/rpc/host-lifecycle-drain.ts";
import { performShutdown, type SupervisorState } from "../../../src/modes/rpc/host-lifecycle-shutdown.ts";

// #3067 L4: the supervisor writes its diagnostics with a synchronous fd write, which a
// unit test cannot observe through process.stderr, so this file records the log module's
// calls instead of spawning a supervisor subprocess. The mock only records: what is
// logged, and in which order, is decided by the production code under test.
const { logged } = vi.hoisted(() => ({ logged: [] as string[] }));
vi.mock("../../../src/modes/rpc/host-supervisor-log.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/host-supervisor-log.ts")>();
	return {
		...actual,
		supervisorLog: (message: string) => {
			logged.push(message);
		},
		writeStderrLine: (text: string) => {
			logged.push(text);
		},
	};
});

/** A pid that belonged to a reaped child: the child never exits. Signalling it is stubbed out below. */
async function deadPid(): Promise<number> {
	const probe = spawn(process.execPath, ["-e", ""]);
	const pid = probe.pid;
	if (pid === undefined) throw new Error("probe child has no pid");
	await new Promise<void>((resolve) => {
		probe.once("exit", () => resolve());
	});
	return pid;
}

// #3067 L4: when the recovery after a pre-signal failure throws, only the recovery error
// is logged and the original error is lost. The recovery must log both — the recovery error
// in stopChild, the original once in performShutdown — and the original must still be the
// error shutdown reports.
it("keeps the pre-signal error when the shutdown recovery itself throws", async () => {
	const root = await mkdtemp(join(tmpdir(), "shutdown-recovery-"));
	const pid = await deadPid();
	const paths = createHostDaemonPaths({ socket: join(root, "rpc.sock"), agentDir: root });
	const generation = generationPaths(paths, "shutdown-recovery");
	await createDaemonDirectories(paths);
	await writeHostRegistration(paths, {
		record: { pid: process.pid, processStartTime: null },
		socket: paths.socket,
		instanceId: "shutdown-recovery",
		generation: 0,
		launchProfileId: "shutdown-recovery-test",
	});
	const child = new ChildProcess();
	(child as { pid: number | undefined }).pid = pid;
	const state: SupervisorState = {
		shuttingDown: false,
		shutdownReason: undefined,
		childExitRecorded: Promise.resolve(),
		startupComplete: Promise.resolve(),
		publicSocketOwned: false,
		publicSocketIdentity: undefined,
		endpointReplaced: false,
	};
	const activity = new SupervisorActivity({
		idleExitMs: Infinity,
		internalSocket: join(root, "internal.sock"),
		instanceId: "shutdown-recovery",
		settled: () => state.shuttingDown,
	});
	const exit = new Error("observed supervisor exit");
	const exitProcess = vi.spyOn(process, "exit").mockImplementation(() => {
		throw exit;
	});
	// The child is already reaped, so the recovery's SIGTERM/SIGKILL would go to a pid
	// the OS may have reused: stub process.kill so no real signal is ever sent, while
	// the recovery still walks its signal-then-wait path (#6144 review).
	const killProcess = vi.spyOn(process, "kill").mockImplementation(() => {
		throw new Error("kill ESRCH: no such process");
	});
	vi.useFakeTimers();
	// Same injection as the supervisor fixture's "inject-stop-error": stopChild reads the
	// time before its first signal, so a throwing clock fails it before the child is signalled.
	// Spy after useFakeTimers so it lands on the fake Date's prototype.
	const clock = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
		throw new Error("injected before child SIGTERM");
	});
	logged.length = 0;
	const stopped = performShutdown(
		{
			paths,
			generation,
			instanceId: "shutdown-recovery",
			publicSocket: paths.socket,
			server: createServer(),
			internalDir: undefined,
			child,
			activity,
			drain: new SupervisorDrain(child, () => state.shuttingDown),
			admission: new HostAdmission({
				protocolVersion: 1,
				serverVersion: "test",
				capabilities: [],
				instanceId: "shutdown-recovery",
			}),
			state,
			stopWatchers: () => {},
		},
		"signal:SIGTERM",
		143,
	).catch((cause: unknown) => {
		if (cause !== exit) throw cause;
		return "exited" as const;
	});
	try {
		// The recovery reaps the never-exiting child: 5 s after SIGTERM, 30 s after SIGKILL.
		// The waits are created lazily as the recovery reaches them, so advance in slices
		// until shutdown settles instead of assuming both timers exist up front. Keep
		// advancing until it settles, with a time bound, rather than a fixed turn
		// count: the real fs read before the injection can consume turns before those
		// timers exist, which a fixed 40-turn loop cannot absorb (#6144 review).
		// Track settlement with a flag, not a Promise.race against an already-resolved
		// promise: the resolved side always wins the race, so that form can never
		// observe the shutdown settling (verified: it returns false even for an
		// already-resolved promise).
		let settled = false;
		stopped.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		for (let advancedMs = 0; advancedMs < 120_000 && !settled; advancedMs += 1_000) {
			await vi.advanceTimersByTimeAsync(1_000);
		}
		expect(settled, "shutdown did not settle within 120 s of fake time").toBe(true);
		await expect(stopped).resolves.toBe("exited");
		expect(exitProcess).toHaveBeenCalledWith(1);
		expect(killProcess).toHaveBeenCalledWith(pid, "SIGTERM");
		expect(killProcess).toHaveBeenCalledWith(pid, "SIGKILL");
		const originals = logged.filter((line) => line.includes("injected before child SIGTERM"));
		const recoveries = logged.filter((line) => line.includes("exit unobserved 30000ms after recovery SIGKILL"));
		expect(originals, "the original error must be logged exactly once").toHaveLength(1);
		expect(recoveries, "the recovery error must be logged exactly once").toHaveLength(1);
		// stopChild logs only the recovery error; performShutdown logs the original once
		// when the rethrow reaches it, so the recovery line now precedes it (#6144 review).
		expect(
			logged.findIndex((line) => line.includes("exit unobserved 30000ms after recovery SIGKILL")),
			"the recovery error is logged in stopChild, before performShutdown logs the original",
		).toBeLessThan(logged.findIndex((line) => line.includes("injected before child SIGTERM")));
	} finally {
		await stopped.catch(() => {});
		vi.useRealTimers();
		clock.mockRestore();
		exitProcess.mockRestore();
		killProcess.mockRestore();
		activity.stopObserver();
		await rm(root, { recursive: true, force: true });
	}
});
