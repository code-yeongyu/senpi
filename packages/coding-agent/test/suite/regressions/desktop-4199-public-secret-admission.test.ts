import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openEndpointReservationStore } from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { HostEnsureRefusedError } from "../../../src/modes/rpc/host-decision.ts";
import { createHostDaemonPaths, ensureHost, hostEnsureLockTarget } from "../../../src/modes/rpc/host-ensure.ts";
import { reservationFile } from "../../../src/modes/rpc/host-reservations.ts";
import { socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { processIsLive, readProcessStartTime } from "../../../src/utils/process-identity.ts";
import { killAndWait } from "../../helpers/spawned-host-reaper.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Admission BEFORE
// mutation", test 5, CLI entry). Security contract: on a Windows public endpoint, a missing or malformed public secret
// with a live or identity-unreadable owner returns `public_secret_recovery_required` before any mutation: the secret
// file keeps its exact state, nothing is spawned and the owner is never signalled. The owner census covers every
// generation directory (not only the one the pointer names), the host child of each, the legacy host, every session
// claim and every reservation in the endpoint's reservation store; an unreadable or incomplete record is unknown, never
// absence. Only an endpoint whose recorded owners are all proven gone provisions a secret.
const roots: string[] = [];
const children: ChildProcess[] = [];
const stores: string[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) await killAndWait(child);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	for (const store of stores.splice(0)) await rm(store, { force: true });
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

interface Identity {
	readonly pid: number;
	readonly processStartTime: string | null;
}

/** Writes one generation's record, the way a supervisor registers itself, without moving the pointer. */
async function writeGeneration(agentDir: string, socket: string, instanceId: string, owner: Identity) {
	const paths = createHostDaemonPaths({ agentDir, socket });
	const writer = { pid: process.pid, startTime: (await readProcessStartTime(process.pid)) ?? null };
	await mkdir(join(paths.generationsDir, instanceId), { recursive: true, mode: 0o700 });
	await writeFile(
		join(paths.generationsDir, instanceId, "host.pid"),
		`${JSON.stringify({ ...owner, instance_id: instanceId, socket, writer })}\n`,
		{ mode: 0o600 },
	);
	return join(paths.generationsDir, instanceId);
}

/** Points the endpoint at `instanceId`, the way a registration names the generation serving the socket. */
async function pointAt(agentDir: string, socket: string, instanceId: string) {
	const paths = createHostDaemonPaths({ agentDir, socket });
	const writer = { pid: process.pid, startTime: (await readProcessStartTime(process.pid)) ?? null };
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await writeFile(
		paths.pointerFile,
		`${JSON.stringify({ layout: 2, instance_id: instanceId, generation_dir: `generations/${instanceId}`, writer })}\n`,
		{ mode: 0o600 },
	);
}

/** Registers `owner` as the endpoint's serving supervisor: its generation record plus the pointer naming it. */
async function registerOwner(agentDir: string, socket: string, owner: Identity) {
	const instanceId = `owner-${owner.pid}`;
	const dir = await writeGeneration(agentDir, socket, instanceId, owner);
	await pointAt(agentDir, socket, instanceId);
	return { instanceId, dir };
}

/** Publishes a session-path claim by `owner`, the way a host records the session file it holds open. */
async function writeClaim(agentDir: string, socket: string, instanceId: string, owner: Identity) {
	const paths = createHostDaemonPaths({ agentDir, socket });
	await mkdir(paths.reservationsDir, { recursive: true, mode: 0o700 });
	const sessionPath = join(agentDir, "sessions", "claimed.jsonl");
	await writeFile(
		reservationFile(paths.reservationsDir, sessionPath),
		`${JSON.stringify({ instanceId, ...owner, sessionPath, attached: true })}\n`,
		{ mode: 0o600 },
	);
}

/** The endpoint's reservation store, beside its endpoint lock, as the launch path opens it. */
async function reservationStore(socket: string) {
	const path = `${hostEnsureLockTarget(socket)}.reservation.db`;
	stores.push(path);
	await mkdir(join(path, ".."), { recursive: true });
	return openEndpointReservationStore(path);
}

const identityKey = (identity: Identity) => JSON.stringify(identity);
const COMMITMENT = createHash("sha256").update("established").digest();

async function liveOwner(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	children.push(child);
	await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
	return child;
}

async function liveIdentity(): Promise<Identity> {
	const pid = (await liveOwner()).pid ?? 0;
	return { pid, processStartTime: (await readProcessStartTime(pid)) ?? null };
}

/** A process that ran and exited: its recorded identity is proven gone, never unknown. */
async function goneIdentity(): Promise<Identity> {
	const child = await liveOwner();
	const pid = child.pid ?? 0;
	const processStartTime = (await readProcessStartTime(pid)) ?? null;
	await killAndWait(child);
	children.splice(children.indexOf(child), 1);
	return { pid, processStartTime };
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
			const owner = await liveIdentity();
			await registerOwner(agentDir, socket, owner);
			if (bytes) await writeFile(secretPath, bytes, { mode: 0o600 });
			const before = await secretState(secretPath);

			const failure = await ensureOnWindows(agentDir, socket);

			expect(failure).toBeInstanceOf(HostEnsureRefusedError);
			expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
			expect(await secretState(secretPath)).toEqual(before);
			expect(processIsLive(owner.pid)).toBe(true);
		},
		20_000,
	);

	it.each(credentials)(
		"refuses a %s secret while the owner's identity is unreadable",
		async (_label, bytes) => {
			const { agentDir, socket, secretPath } = await endpoint();
			const owner = await liveOwner();
			await registerOwner(agentDir, socket, { pid: owner.pid ?? 0, processStartTime: null });
			if (bytes) await writeFile(secretPath, bytes, { mode: 0o600 });
			const before = await secretState(secretPath);

			const failure = await ensureOnWindows(agentDir, socket);

			expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
			expect(await secretState(secretPath)).toEqual(before);
			expect(processIsLive(owner.pid ?? 0)).toBe(true);
		},
		20_000,
	);

	// Design 4.2a: the census covers "all generations (including predecessor/child)". A pointer names one generation;
	// after a handoff the predecessor drains beside the successor, and a crash can leave the pointer on a dead one.
	it("refuses while a predecessor generation is live although the pointer names a dead successor", async () => {
		const { agentDir, socket, secretPath } = await endpoint();
		const predecessor = await liveIdentity();
		await writeGeneration(agentDir, socket, "predecessor", predecessor);
		await registerOwner(agentDir, socket, await goneIdentity());

		const failure = await ensureOnWindows(agentDir, socket);

		expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
		expect(await secretState(secretPath)).toBe("absent");
		expect(processIsLive(predecessor.pid)).toBe(true);
	}, 20_000);

	// Design 4.2a: "an absent pointer ... do[es] not prove offline".
	it("refuses while a live generation remains and the pointer is absent", async () => {
		const { agentDir, socket, secretPath } = await endpoint();
		const owner = await liveIdentity();
		await writeGeneration(agentDir, socket, "unpointed", owner);

		const failure = await ensureOnWindows(agentDir, socket);

		expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
		expect(await secretState(secretPath)).toBe("absent");
		expect(processIsLive(owner.pid)).toBe(true);
	}, 20_000);

	// Design 4.2a lists "session claims" in the census: a host child holding a session file is an owner even when no
	// generation record names it any more.
	it("refuses while a session claim names a live owner", async () => {
		const { agentDir, socket, secretPath } = await endpoint();
		const holder = await liveIdentity();
		await writeClaim(agentDir, socket, "released-generation", holder);

		const failure = await ensureOnWindows(agentDir, socket);

		expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
		expect(await secretState(secretPath)).toBe("absent");
		expect(processIsLive(holder.pid)).toBe(true);
	}, 20_000);

	// Design 4.2a lists "pending reservations" in the census: a launch in progress owns the endpoint before any
	// generation record exists, and an offer nobody has claimed yet names no identity that could be proven gone.
	it.each([
		["its reserving owner is live", liveIdentity],
		["its supervisor offer is unclaimed and its owner is gone", goneIdentity],
	])(
		"refuses while a pending reservation stands because %s",
		async (_label, identity) => {
			const { agentDir, socket, secretPath } = await endpoint();
			const owner = await identity();
			const store = await reservationStore(socket);
			const generation = store.reserve(socket, identityKey(owner), ["supervisor", "host"]);
			store.offer(generation, "supervisor", identityKey(owner));
			store.close();

			const failure = await ensureOnWindows(agentDir, socket);

			expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
			expect(await secretState(secretPath)).toBe("absent");
		},
		20_000,
	);

	// Design 4.2a: incomplete discovery refuses. A supervisor that died between spawning its host child and recording
	// it leaves a generation whose child cannot be proven gone; so does a torn child record.
	it.each([
		["missing", undefined],
		["malformed", "{not json"],
		["unguarded", `${JSON.stringify({ pid: "none" })}\n`],
	])(
		"refuses while the registered supervisor is gone and the host child record is %s",
		async (_label, record) => {
			const { agentDir, socket, secretPath } = await endpoint();
			const { dir } = await registerOwner(agentDir, socket, await goneIdentity());
			if (record !== undefined) await writeFile(join(dir, "host-child.pid"), record, { mode: 0o600 });

			const failure = await ensureOnWindows(agentDir, socket);

			expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
			expect(await secretState(secretPath)).toBe("absent");
		},
		20_000,
	);

	// senpi#4468 r2 LOW: a reservation store another writer holds is unreadable evidence, never a raw error.
	it("refuses typed while the reservation store is held by another writer", async () => {
		const { agentDir, socket, secretPath } = await endpoint();
		const store = await reservationStore(socket);
		const generation = store.reserve(socket, identityKey(await goneIdentity()), ["supervisor", "host"]);
		store.offer(generation, "supervisor", identityKey({ pid: 1, processStartTime: null }));
		store.close();
		const writer = new DatabaseSync(`${hostEnsureLockTarget(socket)}.reservation.db`);
		try {
			writer.exec("BEGIN EXCLUSIVE; UPDATE reservations SET revision = revision + 1;");
			const failure = await ensureOnWindows(agentDir, socket);
			expect(failure).toMatchObject({ reason: "public_secret_recovery_required" });
			expect(String((failure as Error).message)).toMatch(/reservation store/);
		} finally {
			writer.exec("ROLLBACK;");
			writer.close();
		}
		expect(await secretState(secretPath)).toBe("absent");
	}, 20_000);

	it("lets a start through on an endpoint with no owner evidence", async () => {
		const { agentDir, socket } = await endpoint();

		const failure = await ensureOnWindows(agentDir, socket);

		expect(failure).toBe(spawned);
	}, 20_000);

	// Design 4.2a "Offline recovery": once every recorded supervisor, child, claim and reservation identity is proven
	// gone, repair proceeds automatically; retained evidence never blocks a proven-offline endpoint.
	it("lets a start through once every recorded owner is proven gone", async () => {
		const { agentDir, socket } = await endpoint();
		const supervisor = await goneIdentity();
		const host = await goneIdentity();
		const { instanceId, dir } = await registerOwner(agentDir, socket, supervisor);
		await writeFile(join(dir, "host-child.pid"), `${JSON.stringify(host)}\n`, { mode: 0o600 });
		await writeClaim(agentDir, socket, instanceId, host);
		const store = await reservationStore(socket);
		const launcher = await goneIdentity();
		const generation = store.reserve(socket, identityKey(launcher), ["supervisor", "host"]);
		for (const [role, issuer, participant] of [
			["supervisor", launcher, supervisor],
			["host", supervisor, host],
		] as const) {
			store.offer(generation, role, identityKey(issuer));
			const locator = { endpoint: socket, generation, role };
			store.claim(locator, store.readOffer(locator), identityKey(participant));
			store.grant(generation, role, identityKey(issuer), identityKey(participant), COMMITMENT);
		}
		store.markServing(generation);
		store.close();

		const failure = await ensureOnWindows(agentDir, socket);

		expect(failure).toBe(spawned);
	}, 20_000);
});
