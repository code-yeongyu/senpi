import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processMatchesPidFile, readProcessStartTime } from "../src/modes/app-server/daemon/process.ts";
import { HostEnsureRefusedError } from "../src/modes/rpc/host-decision.ts";
import { ensureHost } from "../src/modes/rpc/host-ensure.ts";
import { stopHost } from "../src/modes/rpc/host-stop.ts";
import {
	ensureFixtureHost,
	fixturePath,
	LEGACY_CAPABILITIES,
	permissions,
	readJson,
	refuseToSpawn,
	type Sandbox,
	sandbox,
	spawnDetached,
	startTimeOf,
	sweepSandboxes,
	waitForProtocol,
} from "./helpers/rpc-host-daemon-sandbox.ts";
import { waitForPidGone } from "./helpers/spawned-host-reaper.ts";

afterEach(sweepSandboxes, 60_000);

describe("daemon state directory v2", () => {
	it("registers a pointer and a generation record under the per-socket directory", async () => {
		const qa = await sandbox("layout");
		const started = await ensureFixtureHost(qa);

		const pointer = await readJson(join(qa.daemonDir, "host.pid"));
		expect(pointer).toEqual({
			layout: 2,
			instance_id: expect.any(String),
			generation_dir: `generations/${pointer.instance_id as string}`,
			writer: { pid: process.pid, startTime: expect.any(String) },
		});
		const record = await readJson(join(qa.daemonDir, pointer.generation_dir as string, "host.pid"));
		expect(record).toMatchObject({
			pid: started.pid,
			processStartTime: expect.any(String),
			instance_id: pointer.instance_id,
			generation: 0,
			engineVersion: expect.any(String),
			engineOrdinal: expect.any(Array),
			launchProfileId: expect.any(String),
			socket: qa.socket,
			writer: { pid: process.pid },
		});
	}, 20_000);

	it("names the endpoint in a durable endpoint.json that outlives the host", async () => {
		const qa = await sandbox("endpoint");
		await ensureFixtureHost(qa);
		const identity = join(qa.daemonDir, "endpoint.json");
		const written = await readFile(identity, "utf8");

		expect(JSON.parse(written)).toEqual({
			layout: 2,
			registry_version: 1,
			endpoint_kind: "rpc_host",
			socket: qa.socket,
			created_at: expect.any(String),
		});
		expect(await permissions(identity)).toBe(0o600);
		const stopped = await stopHost({ socket: qa.socket, agentDir: qa.agentDir, force: true });
		expect(stopped.action).toBe("stopped");
		if (stopped.action === "stopped") expect(await waitForPidGone(stopped.pid, 10_000)).toBe(true);

		// This fixture is not a supervisor: stop leaves its pointer until a later ensure prunes it.
		await stat(join(qa.daemonDir, "host.pid"));
		expect(await readFile(identity, "utf8")).toBe(written);
		// A later ensure re-asserts the identity without rewriting it.
		await ensureFixtureHost(qa);
		expect(await readFile(identity, "utf8")).toBe(written);
	}, 20_000);

	it("leaves nothing a legacy client can parse in the flat directory", async () => {
		const qa = await sandbox("flat-dir");
		await ensureFixtureHost(qa);

		const flat = await readdir(qa.flatDir, { withFileTypes: true });
		expect(flat.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).toEqual([qa.daemonDirName]);
		expect(
			flat
				.filter((entry) => !entry.isDirectory())
				.map((entry) => entry.name)
				.sort(),
		).toEqual(["layout.json"]);
		expect(await readJson(join(qa.flatDir, "layout.json"))).toEqual({ layout: 2, dir: qa.daemonDirName });
	}, 20_000);

	it("keeps the directory private and both records owner-only", async () => {
		const qa = await sandbox("perms");
		await ensureFixtureHost(qa);
		const pointer = await readJson(join(qa.daemonDir, "host.pid"));

		expect(await permissions(qa.daemonDir)).toBe(0o700);
		expect(await permissions(join(qa.daemonDir, "generations"))).toBe(0o700);
		expect(await permissions(join(qa.daemonDir, "reservations"))).toBe(0o700);
		expect(await permissions(join(qa.daemonDir, "host.pid"))).toBe(0o600);
		expect(await permissions(join(qa.daemonDir, pointer.generation_dir as string, "host.pid"))).toBe(0o600);
	}, 20_000);

	it("leaves ownership and the stop intent for the supervisor to release after child exit", async () => {
		const qa = await sandbox("stop");
		const running = await registerManagedHost(qa);

		const result = await stopHost({ socket: qa.socket, agentDir: qa.agentDir });

		expect(result).toEqual({ action: "stopped", pid: running.pid });
		expect(await waitForPidGone(running.pid, 10_000)).toBe(true);
		await stat(join(qa.daemonDir, "host.pid"));
		// senpi#2566: the generation directory is the stopped supervisor's to release, after it has recorded its
		// child's end from this intent; this fixture host is no supervisor, so gc reaps the directory instead.
		expect(await readJson(join(qa.daemonDir, "generations", running.instanceId, "stop-intent.json"))).toMatchObject({
			reason: "operator_stop",
			sender: { kind: "stop", pid: process.pid },
			targetPid: running.pid,
		});
	}, 20_000);

	it("fails with the daemon directory in the error when it cannot be created", async () => {
		const qa = await sandbox("unwritable");
		await mkdir(qa.flatDir, { recursive: true });
		await chmod(qa.flatDir, 0o500);

		const failure = await ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: { launch: refuseToSpawn },
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).name).toBe("HostDaemonStateError");
		expect((failure as Error).message).toContain(qa.daemonDir);
		expect(await readdir(qa.flatDir)).toEqual([]);
	}, 20_000);

	it("attaches or refuses on the PROBE when a legacy host answers, and signals nothing", async () => {
		const qa = await sandbox("legacy-answering");
		// The socket answers, so the probe decides - and a host without `session_context` cannot serve
		// a daemon session. The refusal is what a foreign host gets: no signal, no second host.
		const legacy = await spawnDetached([fixturePath(), qa.socket, "2026.9.16-3", LEGACY_CAPABILITIES, "answer"]);
		await waitForProtocol(qa.socket);
		await mkdir(qa.flatDir, { recursive: true });
		const legacyRecord = `${JSON.stringify({ pid: legacy, processStartTime: await startTimeOf(legacy) })}\n`;
		await writeFile(join(qa.flatDir, "host.pid"), legacyRecord, { mode: 0o600 });

		const failure = await ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: { launch: refuseToSpawn },
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("capability");
		expect(await processMatchesPidFile({ pid: legacy, processStartTime: await startTimeOf(legacy) })).toBe(true);
		expect(await readFile(join(qa.flatDir, "host.pid"), "utf8")).toBe(legacyRecord);
	}, 20_000);

	it("refuses to start beside a legacy host whose flat pidfile is still live", async () => {
		const qa = await sandbox("legacy-foreign");
		// A host from before this layout: it registered itself in the FLAT directory and is still
		// running. Its files are somebody else's state - never read as ours, never signalled, never
		// removed - and this ensure may not start a second host beside it either.
		const legacy = await spawnDetached(["-e", "setInterval(() => {}, 1000)"]);
		const flatPidFile = join(qa.flatDir, "host.pid");
		await mkdir(qa.flatDir, { recursive: true });
		const legacyRecord = `${JSON.stringify({ pid: legacy, processStartTime: await startTimeOf(legacy) })}\n`;
		await writeFile(flatPidFile, legacyRecord, { mode: 0o600 });

		const failure = await ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: { launch: refuseToSpawn },
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("legacy_host");
		expect(await processMatchesPidFile({ pid: legacy, processStartTime: await startTimeOf(legacy) })).toBe(true);
		expect(await readFile(flatPidFile, "utf8")).toBe(legacyRecord);
	}, 20_000);
});

/** A registered host that answers nothing: enough for a stop to prove which process it may signal. */
async function registerManagedHost(qa: Sandbox): Promise<{ pid: number; instanceId: string }> {
	const pid = await spawnDetached(["-e", "setInterval(() => {}, 1000)"]);
	const instanceId = "11111111-2222-3333-4444-555555555555";
	const generationDir = join(qa.daemonDir, "generations", instanceId);
	await mkdir(generationDir, { recursive: true, mode: 0o700 });
	const writer = { pid: process.pid, startTime: await readProcessStartTime(process.pid) };
	await writeFile(
		join(generationDir, "host.pid"),
		`${JSON.stringify({
			pid,
			processStartTime: await startTimeOf(pid),
			instance_id: instanceId,
			generation: 0,
			socket: qa.socket,
			writer,
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		join(qa.daemonDir, "host.pid"),
		`${JSON.stringify({ layout: 2, instance_id: instanceId, generation_dir: `generations/${instanceId}`, writer })}\n`,
		{ mode: 0o600 },
	);
	return { pid, instanceId };
}
