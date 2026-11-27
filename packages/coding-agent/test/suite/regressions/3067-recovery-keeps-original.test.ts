import { ChildProcess } from "node:child_process";
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

// #3067 L4: when the recovery after a pre-signal failure throws, only the recovery error
// is logged and the original error is lost. The recovery must log both — the recovery error
// in stopChild, the original once in performShutdown — and the original must still be the
// error shutdown reports.
it("keeps the pre-signal error when the shutdown recovery itself throws", async () => {
	const root = await mkdtemp(join(tmpdir(), "shutdown-recovery-"));
	// #6216: this is a synthetic child; all signals are stubbed. Deliberately use a
	// live pid to prove recovery does not depend on an OS pid remaining unused.
	const pid = process.pid;
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
	const recoveryWaiting = Promise.withResolvers<void>();
	child.on("newListener", (event) => {
		if (event === "exit") recoveryWaiting.resolve();
	});
	const state: SupervisorState = {
		shuttingDown: false,
		shutdownReason: undefined,
		childExitRecorded: Promise.resolve(),
		startupComplete: Promise.resolve(),
		publicSocketOwned: false,
		publicSocketIdentity: undefined,
		endpointReplaced: false,
		childGone: false,
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
	// No real signal is sent, while recovery still walks its signal-then-wait path.
	const killProcess = vi.spyOn(process, "kill").mockImplementation(() => {
		throw new Error("kill ESRCH: no such process");
	});
	// Install the real deadline before faking time: stalled I/O or a missing recovery
	// event must fail promptly, including during cleanup.
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		deadlineTimer = setTimeout(() => reject(new Error("shutdown recovery did not finish within 10 s")), 10_000);
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
			// The stand-in has no OS process to prove; shutdown still reaches its signal seam through a vouched identity (senpi#7525).
			identity: { pid: child.pid, presence: async () => "ours" as const },
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
		// #6216: the real stop-intent read runs before the recovery and may take any number of
		// event-loop turns on a loaded host, so wait for the exit-wait registration itself.
		// newListener observes the exact wait registration, after the real fs read.
		// Its callback runs synchronously; by the time this await resumes, the
		// SIGTERM exit timer exists. Advancing it creates the SIGKILL exit timer.
		await Promise.race([recoveryWaiting.promise, deadline]);
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(Promise.race([stopped, deadline])).resolves.toBe("exited");
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
		Object.defineProperty(child, "exitCode", { value: 0 });
		child.emit("exit", 0, null);
		await Promise.race([stopped, deadline]).catch(() => {});
		vi.useRealTimers();
		clearTimeout(deadlineTimer);
		clock.mockRestore();
		exitProcess.mockRestore();
		killProcess.mockRestore();
		child.removeAllListeners();
		activity.stopObserver();
		await rm(root, { recursive: true, force: true });
	}
});
