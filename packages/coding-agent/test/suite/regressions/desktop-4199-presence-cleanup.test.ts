import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type EndpointReservationStore,
	openEndpointReservationStore,
	type PresenceObjectRecord,
	presenceObjectPath,
	type ReservationRole,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { recoverEndpointReservations, recoveryProber } from "../../../src/modes/rpc/endpoint-recovery.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { startHost } from "../../../src/modes/rpc/host-ensure-start.ts";
import {
	acquireOwnerPresence,
	acquirePresence,
	admitClaimedParticipant,
	claimLaunchRole,
	grantVerifiedParticipant,
	offerHostRole,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
	releaseReservingOwner,
	waitForClaim,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import {
	PRESENCE_SWEEP_AGE_MS,
	PRESENCE_SWEEP_BOUND,
	sweepPresenceObjects,
} from "../../../src/modes/rpc/presence-cleanup.ts";
import { resolvePresenceRoot } from "../../../src/modes/rpc/presence-placement.ts";
import { createSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { fakeProcessTable, fakeWindows } from "../../helpers/fake-windows-presence.ts";

const mocked = vi.hoisted(() => ({ lockDir: "", placement: undefined as unknown }));

vi.mock("../../../src/modes/rpc/host-ensure-lock.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-ensure-lock.ts")>()),
	hostEnsureLockTarget: () => join(mocked.lockDir, "endpoint"),
}));

vi.mock("../../../src/modes/rpc/socket-secret-native.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/socket-secret-native.ts")>();
	return {
		...actual,
		// Every bridge in this file is passed explicitly or installed through `mocked.placement`.
		loadPresencePlacement: vi.fn((...args: Parameters<typeof actual.loadPresencePlacement>) =>
			mocked.placement === undefined ? actual.loadPresencePlacement(...args) : mocked.placement,
		),
	};
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a Revision 7 "Presence
// cleanup", test 24). Security contract: every deletion of a presence object is made by a process that holds the object
// at that moment (on Windows an exclusive open with share mode 0, marked delete-on-close) and only after the database no
// longer needs it: a holder deletes after its `released` commit and after closing its guard, recovery deletes a retired
// generation's objects after releasing its guards and keeps the tombstone, and the bounded sweep, under the endpoint
// lock, deletes only objects it holds whose row is `released` or retired, or which no row references and whose header is
// older than the age filter. A sharing violation leaves the object for the sweep. A live lock is never deleted.
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const ENDPOINT_KEY = "0123456789abcdef0123456789abcdef";
const TARGET = `C:\\Users\\u\\AppData\\Local\\Temp\\senpi-rpc-host-locks\\${ENDPOINT_KEY}`;
const STORE_DIR = "C:\\Users\\u\\AppData\\Local\\Temp\\senpi-rpc-host-locks";
const OWNER = { pid: 100, processStartTime: "134000000000000000" };
const SUPERVISOR = { pid: 4242, processStartTime: "134000000000000000" };
const WRAPPER = { pid: 4343, processStartTime: "134000000000000002" };
const SECRET = Buffer.alloc(32, 7);
const HOUR_MS = 60 * 60 * 1000;

type Machine = ReturnType<typeof fakeWindows>;

function predeclared(object: PresenceObjectRecord | undefined): PresenceObjectRecord & { status: "predeclared" } {
	if (object?.status !== "predeclared") throw new Error(`expected a predeclared object, got ${object?.status}`);
	return object;
}

function nameOf(object: PresenceObjectRecord & { status: "predeclared" }): string {
	return `${object.presenceId}.presence`;
}

describe("#4199 presence cleanup: holder deletion, retirement deletion, bounded sweep (test 24)", () => {
	const roots: string[] = [];
	const stores: EndpointReservationStore[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		mocked.placement = undefined;
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function tempRoot() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-cleanup-"));
		roots.push(root);
		return root;
	}

	async function openStore(path: string) {
		const store = await openEndpointReservationStore(path);
		stores.push(store);
		return store;
	}

	/**
	 * A launch on `machine` that reached a granted supervisor holding its lock; the reserving owner still holds its own
	 * object and nothing has committed `released`. The generation expects `expectedRoles`.
	 */
	async function launched(machine: Machine, expectedRoles: readonly ReservationRole[] = ["supervisor"]) {
		const root = await tempRoot();
		const storePath = join(root, "endpoint.reservation.db");
		const store = await openStore(storePath);
		const reservation = resolvePresenceRoot({
			coordinationTarget: TARGET,
			endpointKey: ENDPOINT_KEY,
			native: machine.load,
		});
		if (reservation.root.status !== "placed") throw new Error("expected a placed root");
		const ownerPresence = acquireOwnerPresence(reservation, machine.load);
		const { generation, args } = offerSupervisorLaunch(
			store,
			ENDPOINT,
			OWNER,
			{ reservation, native: machine.load, ownerPresence },
			expectedRoles,
		);
		const locator = parseReservationLocatorArgs(args);
		if (!locator) throw new Error("no locator");
		await claimLaunchRole(locator, SUPERVISOR, machine.load);
		grantVerifiedParticipant(
			store,
			generation,
			"supervisor",
			OWNER,
			SUPERVISOR,
			createHash("sha256").update(SECRET).digest(),
		);
		const paths = await createHostDaemonPaths({ agentDir: join(root, "agent"), socket: join(root, "rpc.sock") });
		const owner = predeclared(store.reservation(generation).ownerPresence);
		const supervisor = predeclared(store.roleRow(locator)?.presence);
		return { root, storePath, store, generation, locator, paths, reservation, ownerPresence, owner, supervisor };
	}

	/** Process death: the kernel closes every handle the dead processes held, so their locks are free. */
	function crash(machine: Machine) {
		machine.held.clear();
	}

	function recover(launch: Awaited<ReturnType<typeof launched>>, machine: Machine, processes = fakeProcessTable()) {
		return recoverEndpointReservations(
			launch.store,
			ENDPOINT,
			launch.paths,
			recoveryProber(STORE_DIR, machine.load, processes.observe),
		);
	}

	function sweep(launch: Awaited<ReturnType<typeof launched>>, machine: Machine, options = {}) {
		return sweepPresenceObjects(launch.store, launch.reservation.root, machine.load, options);
	}

	/** An object no row references, created `ageMs` before `now`, with a well-formed header. */
	function stray(machine: Machine, rootPath: string, now: number, ageMs: number, content?: string) {
		const presenceId = Buffer.from(`${now - ageMs}:${content ?? ""}`)
			.toString("hex")
			.padEnd(32, "0")
			.slice(0, 32);
		const path = presenceObjectPath(rootPath, presenceId);
		const header =
			content ??
			`${JSON.stringify({ kind: "senpi-presence", schema: 5, tag: "a".repeat(64), createdAt: now - ageMs })}\n`;
		machine.objects.set(path, { content: Buffer.from(header), volumeSerial: "7", fileId: `stray-${presenceId}` });
		return { presenceId, path, name: `${presenceId}.presence` };
	}

	describe("clean exit", () => {
		it("the reserving owner commits `released`, closes its guard, then deletes through an exclusive open", async () => {
			const order: string[] = [];
			const late: { store?: EndpointReservationStore; generation?: string } = {};
			const machine = fakeWindows({
				onRelease: () =>
					order.push(`guard closed while owner ${late.store?.reservation(late.generation ?? "").ownerStatus}`),
				onHold: (request) => order.push(`exclusive open while guard held: ${machine.held.has(request.path)}`),
			});
			const launch = await launched(machine);
			late.store = launch.store;
			late.generation = launch.generation;
			launch.store.markServing(launch.generation);
			// The issuer's post-commit existence check of the supervisor's object is a hold too; only the exit is under test.
			order.length = 0;
			releaseReservingOwner(launch.store, launch.generation, OWNER, launch.ownerPresence);
			expect(order).toEqual(["guard closed while owner released", "exclusive open while guard held: false"]);
			expect(machine.objects.has(launch.owner.path)).toBe(false);
			expect(machine.calls).toContain(`presenceObjectRelease ${nameOf(launch.owner)} delete`);
			// The supervisor's object, still held by a live participant, is untouched.
			expect(machine.objects.has(launch.supervisor.path)).toBe(true);
			expect(machine.holds.size).toBe(0);
		});

		it("a granted participant's release after quiescence commits `released` before the exclusive open and deletes its object", async () => {
			const order: string[] = [];
			const late: { status?: () => string | undefined } = {};
			const machine = fakeWindows({
				onRelease: () => order.push(`guard closed while role ${late.status?.()}`),
				onHold: () => order.push(`exclusive open while role ${late.status?.()}`),
			});
			mocked.placement = machine.load;
			const store = await openStore(join(await tempRoot(), "endpoint.reservation.db"));
			const reservation = resolvePresenceRoot({
				coordinationTarget: TARGET,
				endpointKey: ENDPOINT_KEY,
				native: machine.load,
			});
			const ownerPresence = acquireOwnerPresence(reservation, machine.load);
			const { generation, args } = offerSupervisorLaunch(store, ENDPOINT, OWNER, {
				reservation,
				native: machine.load,
				ownerPresence,
			});
			const locator = parseReservationLocatorArgs(args);
			if (!locator) throw new Error("no locator");
			const supervisor = predeclared(store.roleRow(locator)?.presence);
			late.status = () => store.roleRow(locator)?.status;
			order.length = 0;
			const admitted = admitClaimedParticipant(locator, SUPERVISOR, SECRET, {
				deadlineMs: 5_000,
				presence: machine.load,
			});
			await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
			grantVerifiedParticipant(
				store,
				generation,
				"supervisor",
				OWNER,
				SUPERVISOR,
				createHash("sha256").update(SECRET).digest(),
			);
			const presence = await admitted;
			expect(machine.held.get(supervisor.path)).toBe(supervisor.presenceId);
			expect(order).toEqual([]);
			await presence?.releaseAfterQuiescence();
			expect(order).toEqual(["guard closed while role released", "exclusive open while role released"]);
			expect(machine.objects.has(supervisor.path)).toBe(false);
			expect(machine.holds.size).toBe(0);
		});

		it("the exclusive open fails with a sharing violation while another handle is open; the object is left for the sweep", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			launch.store.markServing(launch.generation);
			const release = machine.native.presenceReleaseAfterQuiescence;
			vi.spyOn(machine.native, "presenceReleaseAfterQuiescence").mockImplementation((receipt) => {
				const result = release(receipt);
				// Between the owner's close and its exclusive open, a prober opened and acquired the object.
				if (receipt.presenceId === launch.owner.presenceId) machine.held.set(launch.owner.path, "prober");
				return result;
			});
			releaseReservingOwner(launch.store, launch.generation, OWNER, launch.ownerPresence);
			expect(launch.store.reservation(launch.generation).ownerStatus).toBe("released");
			expect(machine.calls).toContain(`presenceObjectHold ${nameOf(launch.owner)}`);
			expect(machine.calls).not.toContain(`presenceObjectRelease ${nameOf(launch.owner)} delete`);
			expect(machine.objects.has(launch.owner.path)).toBe(true);
			// The prober's handle is still open: the sweep skips the held object (the live supervisor's is referenced).
			const held = sweep(launch, machine);
			expect(held).toMatchObject({ status: "swept", deleted: [] });
			expect(held.status === "swept" && held.skipped).toContainEqual({ name: nameOf(launch.owner), reason: "held" });
			machine.held.delete(launch.owner.path);
			expect(sweep(launch, machine)).toMatchObject({ deleted: [nameOf(launch.owner)] });
			expect(machine.objects.has(launch.owner.path)).toBe(false);
		});
	});

	describe("retirement", () => {
		it("recovery deletes the retired generation's objects after releasing its guards and keeps the tombstone", async () => {
			const order: string[] = [];
			const late: { store?: EndpointReservationStore; generation?: string } = {};
			const machine = fakeWindows({
				onHold: () =>
					order.push(
						`exclusive open while ${late.store?.reservation(late.generation ?? "").state}, guards held: ${machine.held.size}`,
					),
			});
			const launch = await launched(machine);
			late.store = launch.store;
			late.generation = launch.generation;
			crash(machine);
			order.length = 0;
			expect(await recover(launch, machine)).toEqual({ status: "recovered", generations: [launch.generation] });
			expect(order).toEqual([
				"exclusive open while retired, guards held: 0",
				"exclusive open while retired, guards held: 0",
			]);
			expect(machine.objects.has(launch.owner.path)).toBe(false);
			expect(machine.objects.has(launch.supervisor.path)).toBe(false);
			expect(launch.store.reservation(launch.generation)).toMatchObject({
				state: "retired",
				retirement: { discharges: { owner: "presence_released", supervisor: "presence_released" } },
				ownerPresence: { status: "predeclared", presenceId: launch.owner.presenceId },
			});
			expect(machine.holds.size).toBe(0);
		});

		it("an object another handle holds is left at retirement; the sweep deletes it once it is free", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine, ["supervisor", "host"]);
			offerHostRole(launch.store, launch.generation, SUPERVISOR, machine.load);
			const hostLocator = { ...launch.locator, role: "host" as const };
			const wrapper = await claimLaunchRole(hostLocator, WRAPPER, machine.load);
			const host = predeclared(launch.store.roleRow(hostLocator)?.presence);
			// Everyone died except the suspended wrapper, which still holds the host's predeclared object.
			for (const [path, id] of machine.held) if (id !== host.presenceId) machine.held.delete(path);
			expect(await recover(launch, machine)).toMatchObject({ status: "recovered" });
			expect(machine.objects.has(launch.owner.path)).toBe(false);
			expect(machine.objects.has(launch.supervisor.path)).toBe(false);
			expect(machine.objects.has(host.path)).toBe(true);
			expect(machine.calls).toContain(`presenceObjectHold ${nameOf(host)}`);
			expect(launch.store.reservation(launch.generation).retirement?.discharges.host).toBe("never_granted");
			// Its later grant fails on the tombstone; it closes its unused handle, and the next sweep deletes the object.
			expect(() =>
				grantVerifiedParticipant(launch.store, launch.generation, "host", SUPERVISOR, WRAPPER, Buffer.alloc(32, 1)),
			).toThrow(expect.objectContaining({ reason: "generation_retired" }));
			expect(sweep(launch, machine)).toMatchObject({ skipped: [{ name: nameOf(host), reason: "held" }] });
			wrapper.presence.release();
			expect(sweep(launch, machine)).toMatchObject({ deleted: [nameOf(host)] });
			expect(machine.objects.has(host.path)).toBe(false);
		});
	});

	describe("sweep", () => {
		/**
		 * One root with every kind of object: a retired generation whose deletion at retirement failed, a serving generation
		 * with a released owner and a granted supervisor, and unreferenced objects of both ages, one held, one unreadable.
		 */
		async function populated() {
			const machine = fakeWindows();
			const retired = await launched(machine);
			crash(machine);
			// The retirement's exclusive opens fail (a transient error, not a sharing violation): the objects stay.
			machine.control.holdOutcome = { status: "failed", step: "open", code: 5 };
			expect(await recover(retired, machine)).toMatchObject({ status: "recovered" });
			machine.control.holdOutcome = undefined;
			machine.objects.set(retired.owner.path, {
				content: Buffer.from(retired.owner.header, "hex"),
				volumeSerial: retired.owner.volumeSerial,
				fileId: retired.owner.fileId,
			});
			expect(machine.objects.has(retired.supervisor.path)).toBe(true);
			// A second generation of the same endpoint in the same root, serving, with the owner released and its object left.
			const serving = await launched(machine);
			const store = serving.store;
			serving.store.markServing(serving.generation);
			machine.control.holdOutcome = { status: "failed", step: "open", code: 5 };
			releaseReservingOwner(serving.store, serving.generation, OWNER, serving.ownerPresence);
			machine.control.holdOutcome = undefined;
			expect(machine.objects.has(serving.owner.path)).toBe(true);
			const rootPath = serving.reservation.root.status === "placed" ? serving.reservation.root.path : "";
			const now = 1_800_000_000_000;
			const old = stray(machine, rootPath, now, PRESENCE_SWEEP_AGE_MS + HOUR_MS);
			const young = stray(machine, rootPath, now, PRESENCE_SWEEP_AGE_MS - HOUR_MS);
			const heldStray = stray(machine, rootPath, now, PRESENCE_SWEEP_AGE_MS + 2 * HOUR_MS);
			machine.held.set(heldStray.path, "someone");
			const unreadable = stray(machine, rootPath, now, PRESENCE_SWEEP_AGE_MS + 3 * HOUR_MS, "not a header");
			return { machine, retired, serving, store, now, old, young, heldStray, unreadable };
		}

		it("deletes released, retired and old unreferenced objects; skips a held object, a referenced unreleased object and a young unreferenced one", async () => {
			const { machine, retired, serving, now, old, young, heldStray, unreadable } = await populated();
			const report = sweep(serving, machine, { now: () => now });
			expect(report.status).toBe("swept");
			expect([...(report.status === "swept" ? report.deleted : [])].sort()).toEqual(
				[nameOf(retired.owner), nameOf(retired.supervisor), nameOf(serving.owner), old.name].sort(),
			);
			expect(report.status === "swept" && [...report.skipped].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
				[
					{ name: nameOf(serving.supervisor), reason: "referenced" },
					{ name: young.name, reason: "young" },
					{ name: heldStray.name, reason: "held" },
					{ name: unreadable.name, reason: "unreadable" },
				].sort((a, b) => a.name.localeCompare(b.name)),
			);
			for (const path of [retired.owner.path, retired.supervisor.path, serving.owner.path, old.path]) {
				expect(machine.objects.has(path), path).toBe(false);
			}
			for (const path of [serving.supervisor.path, young.path, heldStray.path, unreadable.path]) {
				expect(machine.objects.has(path), path).toBe(true);
			}
			// Everything it held was released again; the live supervisor's lock was never touched.
			expect(machine.holds.size).toBe(0);
			expect(machine.held.get(serving.supervisor.path)).toBe(serving.supervisor.presenceId);
		});

		it("rechecks the row in a short state transaction while it holds the object, and deletes only what that recheck still discharges", async () => {
			const rechecks: string[] = [];
			const late: { store?: EndpointReservationStore; generation: string; path: string } = {
				generation: "",
				path: "",
			};
			const machine = fakeWindows({
				onHold: (request) => {
					if (request.path !== late.path || !late.store) return;
					// While the sweep holds the object, a writer runs a short transaction of its own: the sweep's recheck must
					// observe the row as committed, and the store may answer busy, never a stale classification.
					const other = late.store;
					rechecks.push(`held during recheck: ${machine.holds.size === 1}`);
					other.reservation(late.generation);
				},
			});
			const launch = await launched(machine);
			launch.store.markServing(launch.generation);
			machine.control.holdOutcome = { status: "failed", step: "open", code: 5 };
			releaseReservingOwner(launch.store, launch.generation, OWNER, launch.ownerPresence);
			machine.control.holdOutcome = undefined;
			late.store = await openStore(launch.storePath);
			late.generation = launch.generation;
			late.path = launch.owner.path;
			// The object the first pass classified `released` is referenced by a row that a concurrent recheck would see
			// unchanged; the live supervisor's object is referenced and its lock held, so it is never opened.
			machine.calls.length = 0;
			const report = sweep(launch, machine);
			expect(report).toMatchObject({
				status: "swept",
				deleted: [nameOf(launch.owner)],
				skipped: [{ name: nameOf(launch.supervisor), reason: "referenced" }],
			});
			expect(rechecks).toEqual(["held during recheck: true"]);
			expect(machine.calls.filter((call) => call.startsWith("presenceObjectHold"))).toEqual([
				`presenceObjectHold ${nameOf(launch.owner)}`,
			]);
		});

		it("handles only its bound per run, in name order", async () => {
			const { machine, serving, now } = await populated();
			machine.calls.length = 0;
			const first = sweep(serving, machine, { now: () => now, bound: 2 });
			expect(first.status).toBe("swept");
			expect(first.status === "swept" && first.bounded).toBe(true);
			expect(machine.calls.filter((call) => call.startsWith("presenceObjectHold"))).toHaveLength(2);
			const second = sweep(serving, machine, { now: () => now });
			expect(second.status === "swept" && second.bounded).toBe(false);
			expect(PRESENCE_SWEEP_BOUND).toBe(32);
		});

		it("runs inside the endpoint-locked start, after recovery and before the owner acquires its own presence", async () => {
			const root = await tempRoot();
			mocked.lockDir = root;
			const machine = fakeWindows();
			mocked.placement = machine.load;
			const socket = join(root, "rpc.sock");
			const agentDir = join(root, "agent");
			await createSocketSecret(socketSecretPath(socket));
			const paths = await createHostDaemonPaths({ agentDir, socket });
			// The root this start will resolve, with an old unreferenced object already in it.
			const rootPath = `\\\\?\\${join(root, "endpoint")}.presence`;
			machine.native.presenceRootOpen(rootPath, true);
			const old = stray(machine, rootPath, Date.now(), PRESENCE_SWEEP_AGE_MS + HOUR_MS);
			const reachedSpawn = new Error("start reached the supervisor spawn");
			vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
			let outcome: unknown;
			await vi.mocked(childProcess.spawn).withImplementation(
				() => {
					throw reachedSpawn;
				},
				async () => {
					outcome = await startHost(paths, socket, { agentDir, socket }).catch((error: unknown) => error);
				},
			);
			vi.unstubAllGlobals();
			expect(outcome).toBe(reachedSpawn);
			const listed = machine.calls.findIndex((call) => call.startsWith("presenceRootList"));
			const acquired = machine.calls.findIndex((call) => call.startsWith("presenceProbe"));
			expect(listed).toBeGreaterThanOrEqual(0);
			expect(acquired).toBeGreaterThan(listed);
			expect(machine.calls).toContain(`presenceObjectRelease ${old.name} delete`);
			expect(machine.objects.has(old.path)).toBe(false);
		});
	});

	describe("delayed actors", () => {
		it("one that locked the object before retirement fails its claim on the tombstone; one that opens after deletion gets not-found and exits", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine, ["supervisor", "host"]);
			offerHostRole(launch.store, launch.generation, SUPERVISOR, machine.load);
			const hostLocator = { ...launch.locator, role: "host" as const };
			const host = predeclared(launch.store.roleRow(hostLocator)?.presence);
			// A delayed wrapper acquired the host's object; everyone else died.
			const early = acquirePresence(host, machine.load);
			for (const [path, id] of machine.held) if (id !== host.presenceId) machine.held.delete(path);
			expect(await recover(launch, machine)).toMatchObject({ status: "recovered" });
			expect(machine.objects.has(host.path)).toBe(true);
			await expect(claimLaunchRole(hostLocator, WRAPPER, machine.load)).rejects.toMatchObject({
				reason: "generation_retired",
			});
			early.release();
			// A second delayed actor opens the supervisor's path after its deletion: not-found, never recreated.
			expect(machine.objects.has(launch.supervisor.path)).toBe(false);
			expect(() => acquirePresence(launch.supervisor, machine.load)).toThrow(
				expect.objectContaining({ reason: "presence_unknown" }),
			);
			expect(machine.objects.has(launch.supervisor.path)).toBe(false);
		});
	});

	describe("probers", () => {
		it("a not-found object makes recovery reread the row; `released` discharges it without the object", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			const other = await openStore(launch.storePath);
			const probe = machine.native.presenceProbe;
			let raced = false;
			vi.spyOn(machine.native, "presenceProbe").mockImplementation((request) => {
				if (request.presenceId === launch.owner.presenceId && !raced) {
					// The owner's clean exit lands between the fenced read and this probe: `released`, then deletion.
					raced = true;
					other.releaseOwner(launch.generation, JSON.stringify(OWNER));
					machine.objects.delete(launch.owner.path);
				}
				return probe(request);
			});
			const processes = fakeProcessTable();
			processes.denied(OWNER.pid);
			expect(await recover(launch, machine, processes)).toMatchObject({ status: "recovered" });
			expect(launch.store.reservation(launch.generation).retirement?.discharges).toEqual({
				owner: "released",
				supervisor: "presence_released",
			});
		});

		it("a missing object for a row that is not discharged stays unknown", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			machine.objects.delete(launch.owner.path);
			const processes = fakeProcessTable();
			processes.denied(OWNER.pid);
			expect(await recover(launch, machine, processes)).toMatchObject({
				status: "refused",
				reason: "authority_unknown",
			});
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
			expect(machine.objects.has(launch.owner.path)).toBe(false);
		});
	});

	describe("issuers", () => {
		/** The object vanishes between its creation and the offer commit. */
		function vanishing(machine: Machine) {
			const create = machine.native.presenceObjectCreate;
			vi.spyOn(machine.native, "presenceObjectCreate").mockImplementation((request) => {
				const created = create(request);
				machine.objects.delete(`${request.rootPath}\\${request.name}`);
				return created;
			});
		}

		it("a reserving owner whose supervisor object vanished cancels the offer, commits its own `released` and deletes its object, before any spawn", async () => {
			const machine = fakeWindows();
			const store = await openStore(join(await tempRoot(), "endpoint.reservation.db"));
			const reservation = resolvePresenceRoot({
				coordinationTarget: TARGET,
				endpointKey: ENDPOINT_KEY,
				native: machine.load,
			});
			const ownerPresence = acquireOwnerPresence(reservation, machine.load);
			const owner = predeclared(ownerPresence.object);
			vanishing(machine);
			expect(() =>
				offerSupervisorLaunch(store, ENDPOINT, OWNER, { reservation, native: machine.load, ownerPresence }),
			).toThrow(expect.objectContaining({ reason: "presence_object_missing" }));
			const [generation] = store.activeGenerations(ENDPOINT);
			expect(store.reservation(generation ?? "")).toMatchObject({ state: "cancelling", ownerStatus: "released" });
			expect(machine.held.size).toBe(0);
			expect(machine.objects.has(owner.path)).toBe(false);
		});

		it("a supervisor whose host object vanished cancels the offer before spawning the host", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine, ["supervisor", "host"]);
			vanishing(machine);
			expect(() => offerHostRole(launch.store, launch.generation, SUPERVISOR, machine.load)).toThrow(
				expect.objectContaining({ reason: "presence_object_missing" }),
			);
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
			expect(launch.store.roleRow({ ...launch.locator, role: "host" })?.status).toBe("revoked");
		});
	});
});
