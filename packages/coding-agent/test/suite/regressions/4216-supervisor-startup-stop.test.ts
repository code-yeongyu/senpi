import { ChildProcess } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// #4216, #4242: startup owns asynchronous writes after the public listener is already reachable.
it.each(["completed", "failed"])("joins %s startup writes before removing the generation", async (outcome) => {
	const root = await mkdtemp(join(tmpdir(), "startup-stop-"));
	const paths = createHostDaemonPaths({ socket: join(root, "rpc.sock"), agentDir: root });
	const generation = generationPaths(paths, "startup-stop");
	await createDaemonDirectories(paths);
	await writeHostRegistration(paths, {
		record: { pid: process.pid, processStartTime: null },
		socket: paths.socket,
		instanceId: "startup-stop",
		generation: 0,
		launchProfileId: "startup-stop-test",
	});
	const releaseWrite = Promise.withResolvers<void>();
	const joined = Promise.withResolvers<void>();
	const startupError = new Error("startup publication failed");
	const write = releaseWrite.promise.then(async () => {
		await writeFile(join(generation.dir, "startup-write"), "complete");
		if (outcome === "failed") throw startupError;
	});
	// Test-only interleaving: observe the join without advancing a clock or releasing the pending writer.
	const startupComplete = write;
	const then = write.then.bind(write);
	const joinSpy = vi.spyOn(write, "then").mockImplementation((fulfilled, rejected) => {
		joined.resolve();
		return then(fulfilled, rejected);
	});
	const state: SupervisorState = {
		shuttingDown: false,
		shutdownReason: undefined,
		childExitRecorded: Promise.resolve(),
		startupComplete,
		publicSocketOwned: false,
		publicSocketIdentity: undefined,
		endpointReplaced: false,
	};
	const child = new ChildProcess();
	const activity = new SupervisorActivity({
		idleExitMs: Infinity,
		internalSocket: join(root, "internal.sock"),
		instanceId: "startup-stop",
		settled: () => state.shuttingDown,
	});
	const exit = new Error("observed supervisor exit");
	const exitProcess = vi.spyOn(process, "exit").mockImplementation(() => {
		throw exit;
	});
	const stopped = performShutdown(
		{
			paths,
			generation,
			instanceId: "startup-stop",
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
				instanceId: "startup-stop",
			}),
			state,
			stopWatchers: () => {},
		},
		outcome === "failed" ? "startup failed" : "signal:SIGTERM",
		outcome === "failed" ? 1 : 143,
	).catch((cause: unknown) => {
		if (cause !== exit) throw cause;
		return "exited" as const;
	});
	try {
		expect(await Promise.race([joined.promise.then(() => "joined"), stopped])).toBe("joined");
		await access(generation.pidFile);
		await access(paths.pointerFile);
		expect(exitProcess).not.toHaveBeenCalled();
		releaseWrite.resolve();
		if (outcome === "failed") await expect(write).rejects.toBe(startupError);
		else await write;
		await stopped;
		expect(exitProcess).toHaveBeenCalledWith(outcome === "failed" ? 1 : 143);
		await expect(access(generation.dir)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(paths.pointerFile)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		releaseWrite.resolve();
		await write.catch(() => {});
		await stopped;
		joinSpy.mockRestore();
		exitProcess.mockRestore();
		activity.stopObserver();
		await rm(root, { recursive: true, force: true });
	}
});
