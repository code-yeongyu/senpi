import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostEnsureRefusedError } from "../../../src/modes/rpc/host-decision.ts";
import { createHostDaemonPaths, ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { processIsLive, readProcessStartTime } from "../../../src/utils/process-identity.ts";
import { killAndWait } from "../../helpers/spawned-host-reaper.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Admission BEFORE
// mutation", test 5, CLI entry). Security contract: on a Windows public endpoint, a missing or malformed public secret
// with a live or identity-unreadable owner returns `public_secret_recovery_required` before any mutation: the secret
// file keeps its exact state, nothing is spawned and the owner is never signalled. Only an endpoint with no owner
// evidence provisions a secret.
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) await killAndWait(child);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const spawned = new Error("a host was spawned");
const refuseToSpawn = (): never => {
	throw spawned;
};

async function endpoint() {
	const root = await mkdtemp(join(tmpdir(), "rpc4199-admission-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const socket = join(root, "rpc.sock");
	return { agentDir, socket, secretPath: socketSecretPath(socket) };
}

/** Registers `pid` as the endpoint's serving supervisor, the way a generation records itself. */
async function registerOwner(agentDir: string, socket: string, pid: number, processStartTime: string | null) {
	const paths = createHostDaemonPaths({ agentDir, socket });
	const instanceId = `owner-${pid}`;
	const writer = { pid: process.pid, startTime: (await readProcessStartTime(process.pid)) ?? null };
	await mkdir(join(paths.generationsDir, instanceId), { recursive: true, mode: 0o700 });
	await writeFile(
		join(paths.generationsDir, instanceId, "host.pid"),
		`${JSON.stringify({ pid, processStartTime, instance_id: instanceId, socket, writer })}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		paths.pointerFile,
		`${JSON.stringify({ layout: 2, instance_id: instanceId, generation_dir: `generations/${instanceId}`, writer })}\n`,
		{ mode: 0o600 },
	);
}

async function liveOwner(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	children.push(child);
	await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
	return child;
}

async function secretState(secretPath: string): Promise<Buffer | "absent"> {
	return readFile(secretPath).catch(() => "absent" as const);
}

function ensureOnWindows(agentDir: string, socket: string) {
	return ensureHost({
		agentDir,
		socket,
		_test: { existingHostProbeTimeoutMs: 200, launch: refuseToSpawn, platform: "win32" },
	}).catch((error: unknown) => error);
}

describe.skipIf(process.platform === "win32")("public secret admission before mutation", () => {
	const credentials: [string, Buffer | undefined][] = [
		["missing", undefined],
		["0-byte", Buffer.alloc(0)],
		["8-byte", Buffer.alloc(8, 1)],
		["31-byte", Buffer.alloc(31, 1)],
		["33-byte", Buffer.alloc(33, 1)],
	];

	it.each(credentials)(
		"refuses a %s secret while the registered owner is live",
		async (_label, bytes) => {
			const { agentDir, socket, secretPath } = await endpoint();
			const owner = await liveOwner();
			const pid = owner.pid ?? 0;
			await registerOwner(agentDir, socket, pid, (await readProcessStartTime(pid)) ?? null);
			if (bytes) await writeFile(secretPath, bytes, { mode: 0o600 });
			const before = await secretState(secretPath);

			const failure = await ensureOnWindows(agentDir, socket);

			expect(failure).toBeInstanceOf(HostEnsureRefusedError);
			expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
			expect(await secretState(secretPath)).toEqual(before);
			expect(processIsLive(pid)).toBe(true);
		},
		20_000,
	);

	it.each(credentials)(
		"refuses a %s secret while the owner's identity is unreadable",
		async (_label, bytes) => {
			const { agentDir, socket, secretPath } = await endpoint();
			const owner = await liveOwner();
			await registerOwner(agentDir, socket, owner.pid ?? 0, null);
			if (bytes) await writeFile(secretPath, bytes, { mode: 0o600 });
			const before = await secretState(secretPath);

			const failure = await ensureOnWindows(agentDir, socket);

			expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
			expect(await secretState(secretPath)).toEqual(before);
			expect(processIsLive(owner.pid ?? 0)).toBe(true);
		},
		20_000,
	);

	it("lets a start through on an endpoint with no owner evidence", async () => {
		const { agentDir, socket } = await endpoint();

		const failure = await ensureOnWindows(agentDir, socket);

		expect(failure).toBe(spawned);
	}, 20_000);
});
