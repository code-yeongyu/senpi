import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EndpointReservationStore,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { startHost } from "../../../src/modes/rpc/host-ensure-start.ts";
import {
	acquireOwnerPresence,
	admitClaimedParticipant,
	claimLaunchRole,
	credentialCommitment,
	grantVerifiedParticipant,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
	releaseReservingOwner,
	reservationStorePath,
	waitForClaim,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { runHostSupervisor } from "../../../src/modes/rpc/host-lifecycle.ts";
import { performShutdown, type SupervisorShutdown } from "../../../src/modes/rpc/host-lifecycle-shutdown.ts";
import { resolvePresenceRoot } from "../../../src/modes/rpc/presence-placement.ts";
import { createSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { fakeWindows } from "../../helpers/fake-windows-presence.ts";

const mocked = vi.hoisted(() => ({ lockDir: "", placement: undefined as unknown, events: [] as string[] }));

vi.mock("../../../src/modes/rpc/host-ensure-lock.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-ensure-lock.ts")>()),
	hostEnsureLockTarget: () => join(mocked.lockDir, "endpoint"),
}));

vi.mock("../../../src/modes/rpc/socket-secret-native.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/socket-secret-native.ts")>();
	return {
		...actual,
		loadPresencePlacement: vi.fn((...args: Parameters<typeof actual.loadPresencePlacement>) =>
			mocked.placement === undefined ? actual.loadPresencePlacement(...args) : mocked.placement,
		),
	};
});

vi.mock("../../../src/modes/rpc/socket-transport.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/socket-transport.ts")>();
	return {
		...actual,
		ensureSocketSecret: vi.fn(async (...args: Parameters<typeof actual.ensureSocketSecret>) => {
			mocked.events.push("credential mutation");
			return actual.ensureSocketSecret(...args);
		}),
	};
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a, Revision 6
// "Acquire before authority; release after quiescence"). Security contract: the reserving process holds its presence
// lock before it mutates the credential and before it persists its reservation; each supervisor/host acquires its
// PREDECLARED presence object before the nonce-claim transaction, which then revalidates the offer and revision and
// records the presence binding; a busy or unknown acquisition ends the start with no claim, spawn or listen, and only an
// unused handle is ever released early; a claimant holds its lock through grant and releases it only after its
// `released` commit. A row with no local presence root (presence_unavailable) keeps the S14a behaviour: no lock.
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const ENDPOINT_KEY = "0123456789abcdef0123456789abcdef";
const TARGET = `C:\\Users\\u\\AppData\\Local\\Temp\\senpi-rpc-host-locks\\${ENDPOINT_KEY}`;
const OWNER = { pid: 100, processStartTime: "133000000000000001" };
const SELF = { pid: 200, processStartTime: "133000000000000002" };
const SECRET = Buffer.alloc(32, 7);
// A commitment is bound to its role and credential path (design 4.2a), never the bare digest of the secret.
const COMMITMENT = credentialCommitment(SECRET, "supervisor", socketSecretPath(ENDPOINT));

function locatorOf(args: readonly string[]) {
	const locator = parseReservationLocatorArgs(args);
	if (locator === undefined) throw new Error("the launch args carry no reservation locator");
	return locator;
}

function supervisorObject(store: EndpointReservationStore, locator: ReturnType<typeof locatorOf>) {
	const presence = store.roleRow(locator)?.presence;
	if (presence?.status !== "predeclared") throw new Error(`expected a predeclared object, got ${presence?.status}`);
	return presence;
}

describe("#4199 participant presence: acquire before authority, release after quiescence", () => {
	const roots: string[] = [];
	const stores: EndpointReservationStore[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		mocked.placement = undefined;
		mocked.events.length = 0;
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function tempRoot() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-participant-"));
		roots.push(root);
		return root;
	}

	async function openStore(path: string) {
		const store = await openEndpointReservationStore(path);
		stores.push(store);
		return store;
	}

	/** A reserving owner that holds its own presence, then reserves and offers the supervisor role. */
	async function offered(fake: ReturnType<typeof fakeWindows>) {
		// Every participant entry under test loads this bridge, as a Windows one would load the real one.
		mocked.placement = fake.load;
		// The endpoint's fixed store beside its (mocked) ensure lock: the one store a claimant's locator may name.
		mocked.lockDir = await tempRoot();
		const store = await openStore(reservationStorePath(ENDPOINT));
		const reservation = resolvePresenceRoot({
			coordinationTarget: TARGET,
			endpointKey: ENDPOINT_KEY,
			native: fake.load,
		});
		const ownerPresence = acquireOwnerPresence(reservation, fake.load);
		const { generation, args } = offerSupervisorLaunch(store, ENDPOINT, OWNER, {
			reservation,
			native: fake.load,
			ownerPresence,
		});
		return { store, generation, locator: locatorOf(args), ownerPresence };
	}

	/** startHost on a Windows endpoint whose supervisor spawn is replaced by a sentinel throw. */
	async function startUntilSpawn(fake: ReturnType<typeof fakeWindows>) {
		const root = await tempRoot();
		mocked.lockDir = root;
		mocked.placement = fake.load;
		const socket = join(root, "rpc.sock");
		const agentDir = join(root, "agent");
		await createSocketSecret(socketSecretPath(socket));
		const paths = await createHostDaemonPaths({ agentDir, socket });
		const reserve = EndpointReservationStore.prototype.reserve;
		const reserved: string[] = [];
		vi.spyOn(EndpointReservationStore.prototype, "reserve").mockImplementation(function (
			this: EndpointReservationStore,
			...args
		) {
			mocked.events.push(`reserve with owner lock held: ${fake.held.size === 1}`);
			const generation = reserve.apply(this, args);
			reserved.push(generation);
			return generation;
		});
		const reachedSpawn = new Error("start reached the supervisor spawn");
		vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
		let outcome: unknown;
		await vi.mocked(childProcess.spawn).withImplementation(
			() => {
				mocked.events.push("spawn");
				throw reachedSpawn;
			},
			async () => {
				outcome = await startHost(paths, socket, { agentDir, socket }).catch((error: unknown) => error);
			},
		);
		vi.unstubAllGlobals();
		return { outcome, reachedSpawn, reserved, storePath: `${join(root, "endpoint")}.reservation.db` };
	}

	it("Acquire before authority: a supervisor acquires its predeclared presence object BEFORE the nonce-claim transaction and records the binding", async () => {
		const fake = fakeWindows();
		const { store, locator } = await offered(fake);
		const object = supervisorObject(store, locator);
		const claim = EndpointReservationStore.prototype.claim;
		vi.spyOn(EndpointReservationStore.prototype, "claim").mockImplementation(function (
			this: EndpointReservationStore,
			...args
		) {
			mocked.events.push(`claim with lock held: ${fake.held.get(object.path) === object.presenceId}`);
			return claim.apply(this, args);
		});
		await claimLaunchRole(locator, SELF, fake.load);
		expect(fake.calls).toContain(`presenceProbe ${object.presenceId}`);
		expect(mocked.events).toEqual(["claim with lock held: true"]);
		expect(store.roleRow(locator)).toMatchObject({
			status: "claimed",
			participant: JSON.stringify(SELF),
			presenceBound: true,
		});
		expect(fake.held.get(object.path)).toBe(object.presenceId);
	});

	it("Acquire before authority: a cancelled offer found when the claim revalidates releases only its own unused handle", async () => {
		const late: { cancel?: () => void } = {};
		const fake = fakeWindows({ onAcquire: () => late.cancel?.() });
		const { store, generation, locator } = await offered(fake);
		late.cancel = () => store.cancel(generation);
		const object = supervisorObject(store, locator);
		await expect(claimLaunchRole(locator, SELF, fake.load)).rejects.toMatchObject({ reason: "generation_cancelled" });
		expect(store.roleRow(locator)).toMatchObject({ status: "revoked", participant: null });
		expect(fake.calls).toContain(`presenceProbe ${object.presenceId}`);
		expect(fake.calls).toContain(`presenceReleaseAfterQuiescence ${object.presenceId}`);
		expect(fake.held.has(object.path)).toBe(false);
	});

	it("Acquire before authority: the claim transaction revalidates the revision and the predeclared object it acquired", async () => {
		const fake = fakeWindows();
		const { store, generation, locator } = await offered(fake);
		const object = supervisorObject(store, locator);
		const nonce = store.readOffer(locator);
		const { revision } = store.reservation(generation);
		expect(() => store.claim(locator, nonce, JSON.stringify(SELF))).toThrow(
			expect.objectContaining({ reason: "presence_not_bound" }),
		);
		expect(() => store.claim(locator, nonce, JSON.stringify(SELF), { revision, presenceId: "f".repeat(32) })).toThrow(
			expect.objectContaining({ reason: "presence_not_bound" }),
		);
		expect(() =>
			store.claim(locator, nonce, JSON.stringify(SELF), { revision: revision - 1, presenceId: object.presenceId }),
		).toThrow(expect.objectContaining({ reason: "revision_changed" }));
		expect(store.roleRow(locator)?.status).toBe("offered");
	});

	it.each([
		["busy", { status: "occupied" } as const, "presence_occupied"],
		["unknown", { status: "unknown", reason: "os_error", code: 5 } as const, "presence_unknown"],
	])(
		"Acquire before authority: a %s acquisition ends the start with no claim; a busy lock never proves the claimed PID",
		async (_label, probeOutcome, reason) => {
			const fake = fakeWindows();
			const { store, locator } = await offered(fake);
			fake.control.probeOutcome = probeOutcome;
			await expect(admitClaimedParticipant(locator, SELF, SECRET, { deadlineMs: 0 })).rejects.toMatchObject({
				reason,
			});
			expect(store.roleRow(locator)).toMatchObject({ status: "offered", participant: null });
		},
	);

	it("Acquire before authority: a supervisor whose presence lock is busy exits without spawning its host or listening", async () => {
		const root = await tempRoot();
		const fake = fakeWindows();
		mocked.placement = fake.load;
		const { store, locator } = await offered(fake);
		fake.control.probeOutcome = { status: "occupied" };
		const listen = vi.spyOn(Server.prototype, "listen");
		const spawned = vi.mocked(childProcess.spawn);
		spawned.mockClear();
		await expect(
			runHostSupervisor({
				socket: join(root, "public.sock"),
				agentDir: join(root, "agent"),
				hostArgs: [],
				reservation: locator,
			}),
		).rejects.toMatchObject({ reason: "presence_occupied" });
		expect(spawned).not.toHaveBeenCalled();
		expect(listen).not.toHaveBeenCalled();
		expect(store.roleRow(locator)?.status).toBe("offered");
	}, 20_000);

	it("Release after quiescence: a claimant holds its lock through the grant and releases it only after its `released` commit", async () => {
		const late: { status?: () => string | undefined } = {};
		const fake = fakeWindows({ onRelease: () => mocked.events.push(`released while role ${late.status?.()}`) });
		const { store, generation, locator } = await offered(fake);
		late.status = () => store.roleRow(locator)?.status;
		const object = supervisorObject(store, locator);
		const admitted = admitClaimedParticipant(locator, SELF, SECRET, { deadlineMs: 5_000 });
		await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SELF, COMMITMENT);
		const presence = await admitted;
		expect(fake.held.get(object.path)).toBe(object.presenceId);
		expect(mocked.events).toEqual([]);
		await presence?.releaseAfterQuiescence();
		expect(mocked.events).toEqual(["released while role released"]);
		expect(fake.held.has(object.path)).toBe(false);
	});

	it("Release after quiescence: the supervisor releases only after its child exited and its listener closed, before it exits", async () => {
		const root = await tempRoot();
		const socket = join(root, "public.sock");
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		const paths = await createHostDaemonPaths({ agentDir: join(root, "agent"), socket });
		const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, pid: undefined });
		const order: string[] = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			order.push(`exit ${code}`);
		}) as typeof process.exit);
		const context: SupervisorShutdown = {
			paths,
			generation: generationPaths(paths, "s12c"),
			instanceId: "s12c",
			publicSocket: socket,
			server,
			internalDir: undefined,
			child: child as unknown as SupervisorShutdown["child"],
			activity: { clients: { destroyAll() {} }, stopObserver() {} } as unknown as SupervisorShutdown["activity"],
			drain: { stop() {}, active: false } as unknown as SupervisorShutdown["drain"],
			admission: { stop() {}, async flush() {} } as unknown as SupervisorShutdown["admission"],
			state: {
				shuttingDown: false,
				shutdownReason: undefined,
				childExitRecorded: Promise.resolve(),
				publicSocketOwned: false,
				publicSocketIdentity: undefined,
				endpointReplaced: false,
			},
			stopWatchers: () => {},
			afterQuiescence: async () => {
				order.push(`release (listening ${server.listening}, child exited ${child.exitCode !== null})`);
			},
		};
		await performShutdown(context, "idle", 0);
		expect(order).toEqual(["release (listening false, child exited true)", "exit 0"]);
	});

	it("Release after quiescence: the reserving owner commits its `released` only once the generation is terminal for it, then closes its guard", async () => {
		const late: { status?: () => string | undefined } = {};
		const fake = fakeWindows({ onRelease: () => mocked.events.push(`owner released while ${late.status?.()}`) });
		const { store, generation, ownerPresence } = await offered(fake);
		late.status = () => store.reservation(generation).ownerStatus;
		if (ownerPresence.object.status !== "predeclared") throw new Error("expected the owner's predeclared object");
		expect(() => releaseReservingOwner(store, generation, OWNER, ownerPresence)).toThrow(
			expect.objectContaining({ reason: "owner_not_terminal" }),
		);
		expect(fake.held.get(ownerPresence.object.path)).toBe(ownerPresence.object.presenceId);
		store.cancel(generation);
		releaseReservingOwner(store, generation, OWNER, ownerPresence);
		expect(mocked.events).toEqual(["owner released while released"]);
		expect(fake.held.has(ownerPresence.object.path)).toBe(false);
	});

	it("Acquire before authority: the reserving owner holds its presence lock before credential mutation and before it persists its reservation", async () => {
		const fake = fakeWindows({ onAcquire: (request) => mocked.events.push(`acquire ${request.presenceId}`) });
		const { outcome, reachedSpawn, reserved, storePath } = await startUntilSpawn(fake);
		expect(outcome).toBe(reachedSpawn);
		const [ownerId] = [...fake.held.values()];
		expect(mocked.events).toEqual([
			`acquire ${ownerId}`,
			"credential mutation",
			"reserve with owner lock held: true",
			"spawn",
		]);
		const store = await openStore(storePath);
		expect(store.reservation(reserved[0] ?? "").ownerPresence).toMatchObject({
			status: "predeclared",
			presenceId: ownerId,
		});
	});

	it.each([
		["busy", { status: "occupied" } as const, "presence_occupied"],
		["unknown", { status: "fenced", reason: "registry_fenced" } as const, "presence_unknown"],
	])(
		"Acquire before authority: a reserving owner whose acquisition is %s mutates no credential, reserves nothing and spawns nothing",
		async (_label, probeOutcome, reason) => {
			const { outcome } = await startUntilSpawn(fakeWindows({ probeOutcome }));
			expect(outcome).toMatchObject({ reason });
			expect(mocked.events).toEqual([]);
		},
	);

	it("a presence_unavailable row keeps the S14a behaviour: no lock is taken, the claim and grant proceed, startup is not refused", async () => {
		const fake = fakeWindows({ storeLocality: "not_local", rootLocality: "not_local" });
		const { store, generation, locator } = await offered(fake);
		expect(store.roleRow(locator)?.presence).toEqual({ status: "presence_unavailable" });
		const admitted = admitClaimedParticipant(locator, SELF, SECRET, { deadlineMs: 5_000 });
		await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SELF, COMMITMENT);
		await expect(admitted).resolves.toBeUndefined();
		expect(store.roleRow(locator)?.status).toBe("granted");
		const startFake = fakeWindows({ storeLocality: "not_local", rootLocality: "not_local" });
		const started = await startUntilSpawn(startFake);
		expect(started.outcome).toBe(started.reachedSpawn);
		const presenceCalls = (calls: readonly string[]) =>
			calls.filter((call) => /^presence(Probe|Acquire|Release)/.test(call));
		expect(presenceCalls(fake.calls)).toEqual([]);
		expect(presenceCalls(startFake.calls)).toEqual([]);
	});
});
