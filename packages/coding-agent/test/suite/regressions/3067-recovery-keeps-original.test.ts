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

/** A pid that belonged to a reaped child: signalling it fails, so the child never exits. */
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
// is logged and the original error is lost. The recovery must log both, the original first,
// and the original must still be the error shutdown reports.
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
		// until shutdown settles instead of assuming both timers exist up front.
		for (let step = 0; step < 40; step++) {
			if (await Promise.race([stopped.then(() => true), Promise.resolve(false)])) break;
			await vi.advanceTimersByTimeAsync(1_000);
		}
		await expect(stopped).resolves.toBe("exited");
		expect(exitProcess).toHaveBeenCalledWith(1);
		const original = logged.findIndex((line) => line.includes("injected before child SIGTERM"));
		const recovery = logged.findIndex((line) => line.includes("exit unobserved 30000ms after recovery SIGKILL"));
		expect(original, "the original error must be logged").not.toBe(-1);
		expect(recovery, "the recovery error must be logged").not.toBe(-1);
		expect(original, "the original error must be logged before the recovery error").toBeLessThan(recovery);
	} finally {
		await stopped.catch(() => {});
		vi.useRealTimers();
		clock.mockRestore();
		exitProcess.mockRestore();
		activity.stopObserver();
		await rm(root, { recursive: true, force: true });
	}
});
