import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
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
	const child = spawn(process.execPath, [
		"-e",
		"process.on('SIGTERM', () => {}); process.stderr.write('ready\\n'); setTimeout(() => {}, 60_000);",
	]);
	if (child.pid === undefined) throw new Error("shutdown child has no pid");
	// Wait until the SIGTERM handler is installed; signalling during startup would kill it.
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("shutdown child did not become ready")), 10_000);
		child.stderr?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("ready\n")) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
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
	if (options.throwFrom === "drain")
		vi.spyOn(drain, "stop").mockImplementation(() => {
			throw new Error("drain stop failed");
		});
	if (options.throwFrom === "destroyAll")
		vi.spyOn(activity.clients, "destroyAll").mockImplementation(() => {
			throw new Error("destroy clients failed");
		});
	const exit = new Error("observed supervisor exit");
	const exitProcess = vi.spyOn(process, "exit").mockImplementation(() => {
		throw exit;
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
			admission: new HostAdmission({
				protocolVersion: 1,
				serverVersion: "test",
				capabilities: [],
				instanceId: "shutdown-call-sites",
			}),
			state,
			stopWatchers: () => {
				if (options.throwFrom === "stopWatchers") throw new Error("stop watchers failed");
			},
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
		stopped,
		cleanup: async () => {
			vi.useRealTimers();
			vi.restoreAllMocks();
			exitProcess.mockRestore();
			activity.stopObserver();
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await Promise.race([
				stopped.catch(() => {}),
				new Promise((resolve) => {
					setTimeout(resolve, 5_000);
				}),
			]);
			await rm(root, { recursive: true, force: true });
		},
	};
}

// Captured before any test fakes the timers: the child is a real process, and its exit
// event is delivered on the real event loop, which fake-timer advances alone never turn.
const realSetTimeout = setTimeout;

/** The waits are created lazily as the stop reaches them; advance until shutdown settles. */
async function settle(stopped: Promise<"exited">): Promise<void> {
	for (let step = 0; step < 40; step++) {
		if (await Promise.race([stopped.then(() => true), Promise.resolve(false)])) return;
		await vi.advanceTimersByTimeAsync(1_000);
		// Let the real loop deliver the child's exit: without this turn, the mocked
		// 30 s kill wait fires before the SIGKILLed child's exit is observed.
		await new Promise((resolve) => {
			realSetTimeout(resolve, 0);
		});
	}
	await expect(stopped).resolves.toBe("exited");
}

// #3067 L5: the `!childStopStarted` path in `performShutdown` isn't covered — one test
// per call site, each showing the child still receives SIGTERM, then SIGKILL, and is
// reaped. The generation is left intact on this path by design (an unobserved child exit
// leaves its generation, pointer and settings intact), and shutdown still exits 1.
it("reaps the child when drain.stop throws before the child is signalled", async () => {
	const rig = await startShutdown({ throwFrom: "drain" });
	try {
		await settle(rig.stopped);
		await expect(rig.stopped).resolves.toBe("exited");
		expect(rig.exitProcess).toHaveBeenCalledWith(1);
		expect(rig.child.signalCode).toBe("SIGKILL");
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
		expect(rig.child.signalCode).toBe("SIGKILL");
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
		expect(rig.child.signalCode).toBe("SIGKILL");
		await expect(access(rig.generation.dir)).resolves.toBeUndefined();
	} finally {
		await rig.cleanup();
	}
});
