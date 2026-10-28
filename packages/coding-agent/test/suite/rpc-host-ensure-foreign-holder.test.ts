/**
 * omo-desktop-app#3561: a `foreign_writer` refusal names the generation in the way.
 *
 * The field shape: terminal `omo` sessions started a shared host on the same agent directory, from a
 * different engine build and with extra extensions. That host is registered by another process,
 * still accepts on the public socket, and does not answer as a host. An ensure must neither signal it
 * (I1) nor start a second host beside it, and its refusal must say WHO holds the endpoint, in the
 * error and in the `host ensure --json` payload every client reads.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostEnsureRefusedError } from "../../src/modes/rpc/host-decision.ts";
import { createHostDaemonPaths, ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { DEFAULT_HOST_LAUNCH_SPEC } from "../../src/modes/rpc/host-launch-spec.ts";
import { HOST_EXIT_REFUSED, runHostRequest } from "../../src/modes/rpc/host-runner.ts";
import { processIsLive, readProcessStartTime } from "../../src/utils/process-identity.ts";
import { reapSpawnedHosts } from "../helpers/spawned-host-reaper.ts";

const CLI_ENGINE = "2026.10.16";
const CLI_PROFILE = "cli-profile-with-agent-mode-extensions";
const CLI_GENERATION = 3;

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	const pending = roots.splice(0);
	await reapSpawnedHosts({ children: children.splice(0), roots: pending });
	for (const root of pending) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

describe.skipIf(process.platform === "win32")("a foreign_writer refusal names its holder (#3561)", () => {
	it("throws the holder the registration names, and leaves it running", async () => {
		const qa = await scratch("error");
		const cli = await startSilentCliHost(qa);
		const failure = await ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: { existingHostProbeTimeoutMs: 500, spawn: refuseToSpawn() },
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		const refusal = failure as HostEnsureRefusedError;
		expect(refusal.reason).toBe("foreign_writer");
		expect(refusal.holder).toEqual(cli.holder);
		expect(refusal.message).toContain(`held by pid ${cli.pid}, engine ${CLI_ENGINE}, launch profile ${CLI_PROFILE}`);
		expect(processIsLive(cli.pid)).toBe(true);
	}, 20_000);

	it("reports the holder in the `host ensure` payload", async () => {
		const qa = await scratch("payload");
		const cli = await startSilentCliHost(qa);
		const outcome = await runHostRequest({
			action: "ensure",
			target: { socket: qa.socket, agentDir: qa.agentDir },
			spec: DEFAULT_HOST_LAUNCH_SPEC,
			policy: "upgrade",
		});
		expect(outcome.exitCode).toBe(HOST_EXIT_REFUSED);
		expect(outcome.payload).toMatchObject({ action: "refuse", reason: "foreign_writer", holder: cli.holder });
		expect(processIsLive(cli.pid)).toBe(true);
	}, 40_000);
});

type Qa = { root: string; agentDir: string; socket: string };

async function scratch(label: string): Promise<Qa> {
	const root = await mkdtemp(join(tmpdir(), `senpi-foreign-holder-${label}-`));
	roots.push(root);
	return { root, agentDir: join(root, "agent"), socket: join(root, "rpc.sock") };
}

function refuseToSpawn(): { command: string; args: string[] } {
	return { command: process.execPath, args: ["-e", "process.exit(97)"] };
}

/**
 * The CLI-started host as the desktop finds it: alive, accepting on the public socket and silent, its
 * generation registered by ANOTHER process (the CLI's own `host ensure`) with a different engine build
 * and launch profile than this client's.
 */
async function startSilentCliHost(qa: Qa) {
	const host = await spawnSilentListener(qa.socket);
	const writer = await spawnIdleProcess();
	const pid = host.pid ?? 0;
	const writerPid = writer.pid ?? 0;
	const instanceId = `cli-${pid}`;
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	const stamp = { pid: writerPid, startTime: (await readProcessStartTime(writerPid)) ?? null };
	await mkdir(join(paths.generationsDir, instanceId), { recursive: true, mode: 0o700 });
	const record = {
		pid,
		processStartTime: (await readProcessStartTime(pid)) ?? null,
		instance_id: instanceId,
		generation: CLI_GENERATION,
		engineVersion: CLI_ENGINE,
		launchProfileId: CLI_PROFILE,
		socket: qa.socket,
		writer: stamp,
	};
	await writeFile(join(paths.generationsDir, instanceId, "host.pid"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
	const pointer = { layout: 2, instance_id: instanceId, generation_dir: `generations/${instanceId}`, writer: stamp };
	await writeFile(paths.pointerFile, `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
	return {
		pid,
		holder: {
			pid,
			instanceId,
			generation: CLI_GENERATION,
			processStartTime: record.processStartTime,
			engineVersion: CLI_ENGINE,
			launchProfileId: CLI_PROFILE,
			writerPid,
		},
	};
}

async function spawnSilentListener(socket: string): Promise<ChildProcess> {
	const script = [
		'const net = require("node:net");',
		'net.createServer(() => {}).listen(process.env.HELD_SOCKET, () => process.stdout.write("listening\\n"));',
		"setInterval(() => {}, 1000);",
	].join(" ");
	const child = spawn(process.execPath, ["-e", script], {
		stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, HELD_SOCKET: socket },
	});
	children.push(child);
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.once("exit", (code) => reject(new Error(`listener exited before listening (code ${code})`)));
	});
	return child;
}

async function spawnIdleProcess(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", reject);
	});
	return child;
}
