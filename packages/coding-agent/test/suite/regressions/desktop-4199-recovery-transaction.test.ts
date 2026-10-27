import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type EndpointReservationStore,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { recoverEndpointReservations, recoveryProber } from "../../../src/modes/rpc/endpoint-recovery.ts";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { recordLaunchProvenance } from "../../../src/modes/rpc/launch-provenance.ts";
import {
	acquireOwnerPresence,
	claimLaunchRole,
	grantVerifiedParticipant,
	offerHostRole,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
	reservationStorePath,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { resolvePresenceRoot } from "../../../src/modes/rpc/presence-placement.ts";
import {
	cloneMachine,
	FAKE_KERNEL_SESSION,
	fakeProcessTable,
	fakeWindows,
} from "../../helpers/fake-windows-presence.ts";

const mocked = vi.hoisted(() => ({ lockDir: "" }));

// The endpoint's fixed reservation store lives beside its ensure lock (design 4.2a step 1), whose win32 name comes from
// the pipe-address formula; on a POSIX runner the lock target is pointed at each test's own directory instead.
vi.mock("../../../src/modes/rpc/host-ensure-lock.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-ensure-lock.ts")>()),
	hostEnsureLockTarget: () => join(mocked.lockDir, "endpoint"),
}));

vi.mock("../../../src/modes/rpc/socket-secret-native.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/socket-secret-native.ts")>()),
	// Every bridge in this file is passed explicitly; a default load would be the real (absent) one.
	loadPresencePlacement: () => ({ status: "unavailable", reason: "native_unavailable" }),
}));

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Recovery transaction
// order", "Admissibility", "Process evidence and the kernel-session gate (Revision 8)", "Probe set"; tests 11, 19, 22,
// 23 and 29). Security contract: recovery fences an abandoned generation, probes ONLY the reserving owner until its
// `released` and every granted role without `released`, in presence-ID order and outside every state transaction; an
// acquisition counts only when admissible (rules 1-3), a busy object always blocks, and reopened-PID evidence of a row
// another invocation wrote counts only on a store recorded and still classified `local` (clause iii) or under verified,
// equal kernel sessions (clauses i and iv). It retires only after a complete census, at the revision it revalidated,
// holding the recovered guards through that commit.
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const ENDPOINT_KEY = "0123456789abcdef0123456789abcdef";
const TARGET = `C:\\Users\\u\\AppData\\Local\\Temp\\senpi-rpc-host-locks\\${ENDPOINT_KEY}`;
const STORE_DIR = "C:\\Users\\u\\AppData\\Local\\Temp\\senpi-rpc-host-locks";
const OWNER = { pid: 100, processStartTime: "134000000000000000" };
const SUPERVISOR = { pid: 4242, processStartTime: "134000000000000000" };
const SECRET = Buffer.alloc(32, 7);
const S1 = "133100000000000000";
const S2 = "133200000000000000";

type Machine = ReturnType<typeof fakeWindows>;

describe("#4199 recovery transaction: probe set, admissibility, kernel-session gate, census", () => {
	const roots: string[] = [];
	const stores: EndpointReservationStore[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function tempRoot() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-recovery-"));
		roots.push(root);
		return root;
	}

	async function openStore(path: string) {
		const store = await openEndpointReservationStore(path);
		stores.push(store);
		return store;
	}

	/**
	 * A launch on `machine` that reached a granted supervisor holding its lock, as startHost and the supervisor leave it;
	 * the reserving owner still holds its own object. Nothing has committed `released`.
	 */
	async function launched(machine: Machine) {
		const root = await tempRoot();
		mocked.lockDir = root;
		const storePath = reservationStorePath(ENDPOINT);
		const store = await openStore(storePath);
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
		return { root, storePath, store, generation, locator, paths };
	}

	/** Process death: the kernel closes every handle the dead processes held, so their locks are free. */
	function crash(machine: Machine) {
		machine.held.clear();
	}

	function recover(
		launch: Awaited<ReturnType<typeof launched>>,
		machine: Machine,
		processes = fakeProcessTable(),
		store = launch.store,
	) {
		return recoverEndpointReservations(
			store,
			ENDPOINT,
			launch.paths,
			recoveryProber(STORE_DIR, machine.load, processes.observe, launch.paths.dir),
		);
	}

	/**
	 * A generation directory with the launch provenance the reserving owner writes beside the rows its launch produces
	 * (the reservation generation, the owner's kernel session, the daemon directory's classification at the write).
	 */
	async function provenanced(
		launch: Awaited<ReturnType<typeof launched>>,
		instanceId: string,
		provenance: {
			readonly kernelSession: string | null;
			readonly directoryLocal: boolean;
			readonly generation?: string;
		},
	) {
		const instance = generationPaths(launch.paths, instanceId);
		await mkdir(instance.dir, { recursive: true });
		await recordLaunchProvenance(instance.launchProvenanceFile, {
			generation: provenance.generation ?? launch.generation,
			kernelSession:
				provenance.kernelSession === null
					? { status: "unverified", reason: "access_denied" }
					: { status: "verified", value: provenance.kernelSession },
			directoryLocal: provenance.directoryLocal,
		});
		return instance;
	}

	function probes(machine: Machine) {
		return machine.calls.filter((call) => call.startsWith("presenceProbe"));
	}

	it("test 11 (local store): fences, acquires every probed object in presence-ID order, retires holding them, then releases", async () => {
		const machine = fakeWindows();
		const launch = await launched(machine);
		crash(machine);
		const owner = launch.store.reservation(launch.generation).ownerPresence;
		const supervisor = launch.store.roleRow(launch.locator)?.presence;
		if (owner.status !== "predeclared" || supervisor?.status !== "predeclared") throw new Error("expected objects");
		const order: string[] = [];
		const release = machine.native.presenceReleaseAfterQuiescence;
		vi.spyOn(machine.native, "presenceReleaseAfterQuiescence").mockImplementation((receipt) => {
			order.push(`release while ${launch.store.reservation(launch.generation).state}`);
			return release(receipt);
		});
		machine.calls.length = 0;
		const outcome = await recover(launch, machine);
		expect(outcome).toEqual({ status: "recovered", generations: [launch.generation] });
		expect(probes(machine)).toEqual(
			[owner.presenceId, supervisor.presenceId].sort().map((id) => `presenceProbe ${id}`),
		);
		// The host role was never offered in this launch, so it has no entry to discharge.
		expect(launch.store.reservation(launch.generation)).toMatchObject({ state: "retired" });
		expect(launch.store.reservation(launch.generation).retirement?.discharges).toEqual({
			owner: "presence_released",
			supervisor: "presence_released",
		});
		expect(order).toEqual(["release while retired", "release while retired"]);
		expect(machine.held.size).toBe(0);
	});

	it("probe set: a suspended late wrapper holding a claimed-but-never-granted role's object is not probed and cannot block", async () => {
		const machine = fakeWindows();
		const launch = await launched(machine);
		offerHostRole(launch.store, launch.generation, SUPERVISOR, machine.load);
		const host = { ...launch.locator, role: "host" as const };
		const wrapper = { pid: 4343, processStartTime: "134000000000000002" };
		await claimLaunchRole(host, wrapper, machine.load);
		const object = launch.store.roleRow(host)?.presence;
		if (object?.status !== "predeclared") throw new Error("expected an object");
		// Everyone died except the suspended wrapper, which still holds the host's predeclared object.
		for (const [path, id] of machine.held) if (id !== object.presenceId) machine.held.delete(path);
		machine.calls.length = 0;
		expect(await recover(launch, machine)).toMatchObject({ status: "recovered" });
		expect(probes(machine)).not.toContain(`presenceProbe ${object.presenceId}`);
		expect(launch.store.reservation(launch.generation).retirement?.discharges.host).toBe("never_granted");
		// Its later grant fails on the tombstone.
		expect(() =>
			grantVerifiedParticipant(launch.store, launch.generation, "host", SUPERVISOR, wrapper, Buffer.alloc(32, 1)),
		).toThrow(expect.objectContaining({ reason: "generation_retired" }));
	});

	it("test 19: a busy object blocks whatever the process evidence says; this attempt's guards are released, the fence stays", async () => {
		const machine = fakeWindows();
		const launch = await launched(machine);
		// The owner died; the granted supervisor is alive and paused before bind, still holding its object.
		const supervisor = launch.store.roleRow(launch.locator)?.presence;
		if (supervisor?.status !== "predeclared") throw new Error("expected an object");
		for (const [path, id] of machine.held) if (id !== supervisor.presenceId) machine.held.delete(path);
		const outcome = await recover(launch, machine);
		expect(outcome).toMatchObject({ status: "refused", reason: "presence_occupied" });
		expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
		expect([...machine.held.values()]).toEqual([supervisor.presenceId]);
	});

	it("test 19: a missing object is unknown and never recreated; only the exact process proof can then discharge its entry", async () => {
		const machine = fakeWindows();
		const launch = await launched(machine);
		crash(machine);
		const owner = launch.store.reservation(launch.generation).ownerPresence;
		if (owner.status !== "predeclared") throw new Error("expected an object");
		machine.objects.delete(owner.path);
		const processes = fakeProcessTable();
		processes.live(OWNER.pid, OWNER.processStartTime);
		expect(await recover(launch, machine, processes)).toMatchObject({ status: "refused", reason: "authority_live" });
		processes.table.delete(OWNER.pid);
		expect(await recover(launch, machine, processes)).toMatchObject({ status: "recovered" });
		expect(launch.store.reservation(launch.generation).retirement?.discharges.owner).toBe("process_gone");
		expect(machine.objects.has(owner.path)).toBe(false);
	});

	it("test 19: a replaced tag or file identity and a denied open are not release proof", async () => {
		for (const tamper of ["tag", "file_id", "denied"] as const) {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			const owner = launch.store.reservation(launch.generation).ownerPresence;
			if (owner.status !== "predeclared") throw new Error("expected an object");
			const object = machine.objects.get(owner.path);
			if (!object) throw new Error("expected the owner's object");
			if (tamper === "tag") object.content = Buffer.from("replaced");
			if (tamper === "file_id") object.fileId = "9999";
			if (tamper === "denied") machine.control.probeOutcome = { status: "unknown", reason: "os_error", code: 5 };
			const processes = fakeProcessTable();
			processes.denied(OWNER.pid);
			expect(await recover(launch, machine, processes)).toMatchObject({
				status: "refused",
				reason: "authority_unknown",
			});
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
		}
	});

	it("test 19: no probe runs inside a state transaction", async () => {
		const machine = fakeWindows({
			onAcquire: () => {
				// Another writer can take the store's write lock while a presence probe is in flight.
				const other = new DatabaseSync(storePath.value);
				try {
					other.exec("BEGIN IMMEDIATE; ROLLBACK;");
				} finally {
					other.close();
				}
			},
		});
		const storePath = { value: "" };
		const launch = await launched(machine);
		storePath.value = launch.storePath;
		crash(machine);
		expect(await recover(launch, machine)).toMatchObject({ status: "recovered" });
	});

	it("test 19: a revision change after the revalidation invalidates the census; nothing retires", async () => {
		const machine = fakeWindows();
		const launch = await launched(machine);
		crash(machine);
		const instance = await provenanced(launch, "old-generation", {
			kernelSession: FAKE_KERNEL_SESSION,
			directoryLocal: true,
		});
		await writeFile(instance.pidFile, JSON.stringify({ pid: 5151, processStartTime: "134000000000000005" }));
		const other = await openStore(launch.storePath);
		const processes = fakeProcessTable();
		const observe = processes.observe;
		processes.observe = async (pid) => {
			// A delayed actor commits while the census runs.
			other.release(launch.generation, "supervisor", JSON.stringify(SUPERVISOR));
			return observe(pid);
		};
		expect(await recover(launch, machine, processes)).toMatchObject({
			status: "refused",
			reason: "revision_changed",
		});
		expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
		expect(machine.held.size).toBe(0);
	});

	it("step 4: a role that committed `released` while recovery probed is discharged by that commit, and its guard released", async () => {
		const machine = fakeWindows({
			onAcquire: () => {
				if (late.done || !late.store) return;
				late.done = true;
				late.store.release(late.generation, "supervisor", JSON.stringify(SUPERVISOR));
			},
		});
		const late: { store?: EndpointReservationStore; generation: string; done: boolean } = {
			generation: "",
			done: false,
		};
		const launch = await launched(machine);
		crash(machine);
		late.store = await openStore(launch.storePath);
		late.generation = launch.generation;
		expect(await recover(launch, machine)).toMatchObject({ status: "recovered" });
		expect(launch.store.reservation(launch.generation).retirement?.discharges).toMatchObject({
			owner: "presence_released",
			supervisor: "released",
		});
		expect(machine.held.size).toBe(0);
	});

	it("test 11 census: every recorded generation, host child and session claim is observed exactly; a one-tick FILETIME difference is gone", async () => {
		const machine = fakeWindows();
		const launch = await launched(machine);
		crash(machine);
		const instance = await provenanced(launch, "old-generation", {
			kernelSession: FAKE_KERNEL_SESSION,
			directoryLocal: true,
		});
		await writeFile(instance.pidFile, JSON.stringify({ pid: 4242, processStartTime: "134000000000000000" }));
		await writeFile(instance.childPidFile, JSON.stringify({ pid: 4343, processStartTime: "134000000000000002" }));
		await mkdir(launch.paths.reservationsDir, { recursive: true });
		await writeFile(
			join(launch.paths.reservationsDir, "claim.json"),
			JSON.stringify({
				instanceId: "old-generation",
				pid: 4444,
				processStartTime: "134000000000000004",
				sessionPath: "s",
			}),
		);
		const processes = fakeProcessTable();
		// An unrelated live replacement at the supervisor's PID, created one second later: a 3 s tolerance would match it.
		// The row names the supervisor's exact recorded identity, so it is the supervisor's own entry, discharged by its
		// admissible acquisition (step 3) and never observed; the replacement is neither signalled nor adopted.
		processes.live(4242, "134000000010000000");
		processes.live(4343, "134000000000000002");
		expect(await recover(launch, machine, processes)).toMatchObject({ status: "refused", reason: "census_live" });
		processes.live(4343, "134000000000000003");
		processes.denied(4444);
		expect(await recover(launch, machine, processes)).toMatchObject({ status: "refused", reason: "census_unknown" });
		processes.live(4444, "134000000000000005");
		expect(await recover(launch, machine, processes)).toMatchObject({ status: "recovered" });
		expect(processes.observed).toEqual(expect.arrayContaining([4343, 4444]));
		expect(processes.observed).not.toContain(4242);
	});

	describe("network-root rows (relocated presence)", () => {
		const relocated = (kernelSession: string | null) => fakeWindows({ storeLocality: "not_local", kernelSession });

		it("test 29 clauses (i) and (iv): admissible only when both kernel sessions are verified and equal", async () => {
			for (const [recorded, prober, expected] of [
				[S1, S1, "recovered"],
				[S1, S2, "refused"],
				[S1, null, "refused"],
				[null, S1, "refused"],
				[null, null, "refused"],
			] as const) {
				const machine = relocated(recorded);
				const launch = await launched(machine);
				crash(machine);
				machine.control.kernelSession =
					prober === null
						? { status: "unverified", creationTime: null, reason: "access_denied" }
						: { status: "verified", creationTime: prober, reason: null };
				// The recorded processes are absent: only the gate decides.
				const outcome = await recover(launch, machine);
				expect(outcome.status, `recorded ${recorded}, prober ${prober}`).toBe(expected);
			}
		});

		it("test 29: a row recorded not_local stays gated even when its store now classifies local", async () => {
			const machine = relocated(null);
			const launch = await launched(machine);
			crash(machine);
			machine.control.storeLocality = "local";
			expect(await recover(launch, machine)).toMatchObject({ status: "refused", reason: "authority_unknown" });
		});

		it("test 23: a disk clone sharing the network store refuses while the original's participant lives; the original recovers after it exits", async () => {
			const original = relocated(S1);
			const launch = await launched(original);
			// The owner exited on the original machine; its granted supervisor is paused before bind and holds its object.
			const supervisor = launch.store.roleRow(launch.locator)?.presence;
			if (supervisor?.status !== "predeclared") throw new Error("expected an object");
			for (const [path, id] of original.held) if (id !== supervisor.presenceId) original.held.delete(path);
			const clone = cloneMachine(original, { storeLocality: "not_local", kernelSession: S2 });
			const refused = await recover(launch, clone);
			expect(refused).toMatchObject({ status: "refused", reason: "authority_unknown" });
			expect(refused.status === "refused" && refused.detail).toContain(S1);
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
			// Revision 8: both identities unverified on the clone stay unknown too.
			const unverifiedClone = cloneMachine(original, { storeLocality: "not_local", kernelSession: null });
			expect(await recover(launch, unverifiedClone)).toMatchObject({ status: "refused" });
			crash(original);
			expect(await recover(launch, original)).toMatchObject({ status: "recovered" });
		});

		it("test 23 negative control: with the clone's session equal to the original's the same fixture admits a successor", async () => {
			const original = relocated(S1);
			const launch = await launched(original);
			const supervisor = launch.store.roleRow(launch.locator)?.presence;
			if (supervisor?.status !== "predeclared") throw new Error("expected an object");
			const clone = cloneMachine(original, { storeLocality: "not_local", kernelSession: S1 });
			expect(await recover(launch, clone)).toMatchObject({ status: "recovered" });
			// The live original still holds its object: this is exactly the unsafe outcome the gate prevents.
			expect([...original.held.values()]).toContain(supervisor.presenceId);
		});
	});

	it("test 22/29: a row recorded local whose store flipped to not_local is unknown and stays gated", async () => {
		const machine = fakeWindows({ kernelSession: null });
		const launch = await launched(machine);
		crash(machine);
		for (const directory of machine.directories.values()) directory.locality = "not_local";
		machine.control.storeLocality = "not_local";
		expect(await recover(launch, machine)).toMatchObject({ status: "refused", reason: "authority_unknown" });
	});

	describe("test 17 (Windows half): confirmed reboot on a local store", () => {
		/** Every row written in session S1 on a local store; the census has a supervisor whose identity is unreadable now. */
		async function rebooted(options: {
			storeLocality?: "local" | "not_local";
			prober: string | null;
			/** The store recorded `local` and no longer classifies `local`, while its presence directory still does. */
			storeFlipped?: boolean;
		}) {
			const machine = fakeWindows({ kernelSession: S1, storeLocality: options.storeLocality ?? "local" });
			const launch = await launched(machine);
			// The fake reboot: every local actor exited and the kernel released their locks; nothing updated the rows.
			crash(machine);
			if (options.storeFlipped) machine.control.storeLocality = "not_local";
			machine.control.kernelSession =
				options.prober === null
					? { status: "unverified", creationTime: null, reason: "access_denied" }
					: { status: "verified", creationTime: options.prober, reason: null };
			// A row the prior boot's launch wrote on the local daemon directory, with its provenance beside it: an earlier
			// generation's supervisor, not one of this generation's recorded actors.
			const instance = await provenanced(launch, "old-generation", { kernelSession: S1, directoryLocal: true });
			await writeFile(instance.pidFile, JSON.stringify({ pid: 4545, processStartTime: "134000000000000045" }));
			const processes = fakeProcessTable();
			processes.denied(4545);
			return { machine, launch, processes };
		}

		// senpi#4479 LOW / senpi#4481 HIGH: the prior-boot proof resolves only entries provably from that boot; every other
		// entry is observed as usual, and one without provenance stays unknown.
		it.each([
			[
				"a current-boot entry whose process is live",
				{ kernelSession: S2, directoryLocal: true },
				(processes: ReturnType<typeof fakeProcessTable>) => processes.live(5252, "134000000000000050"),
				"census_live",
			],
			[
				"an entry whose session is unverified and whose identity is denied",
				{ kernelSession: null, directoryLocal: true },
				(processes: ReturnType<typeof fakeProcessTable>) => processes.denied(5252),
				"census_unknown",
			],
			[
				"an entry with no recorded provenance (a legacy writer)",
				undefined,
				(processes: ReturnType<typeof fakeProcessTable>) => processes.denied(5252),
				"census_unknown",
			],
		] as const)(
			"after a proven reboot, %s is not resolved by the reboot",
			async (_label, provenance, table, reason) => {
				const { machine, launch, processes } = await rebooted({ prober: S2 });
				const instance = provenance
					? await provenanced(launch, "other-generation", provenance)
					: generationPaths(launch.paths, "other-generation");
				await mkdir(instance.dir, { recursive: true });
				await writeFile(instance.pidFile, JSON.stringify({ pid: 5252, processStartTime: "134000000000000050" }));
				table(processes);
				expect(await recover(launch, machine, processes)).toMatchObject({ status: "refused", reason });
				expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
			},
		);

		it("prior-boot entries resolve gone after the presence census, and exactly one successor can be reserved", async () => {
			const { machine, launch, processes } = await rebooted({ prober: S2 });
			expect(await recover(launch, machine, processes)).toMatchObject({ status: "recovered" });
			expect(launch.store.activeGenerations(ENDPOINT)).toEqual([]);
		});

		it.each([
			["the same kernel session (Fast Startup or resume, no new kernel)", { prober: S1 }],
			["an unverified current session", { prober: null }],
			[
				"a non-local store, where a restart and a clone look the same",
				{ prober: S2, storeLocality: "not_local" as const },
			],
			["a store that classified local when written but no longer does", { prober: S2, storeFlipped: true }],
		])("%s is no reboot proof", async (_label, options) => {
			const { machine, launch, processes } = await rebooted(options);
			expect(await recover(launch, machine, processes)).toMatchObject({ status: "refused" });
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
		});

		it("a still-busy presence object after a purported reboot blocks; it is never ignored", async () => {
			const { machine, launch, processes } = await rebooted({ prober: S2 });
			const supervisor = launch.store.roleRow(launch.locator)?.presence;
			if (supervisor?.status !== "predeclared") throw new Error("expected an object");
			machine.held.set(supervisor.path, supervisor.presenceId);
			expect(await recover(launch, machine, processes)).toMatchObject({
				status: "refused",
				reason: "presence_occupied",
			});
		});
	});

	// senpi#4479 MEDIUM 1: a census row carries only the provenance its own launch recorded beside it, never the
	// reservation store's locality or the owner's kernel session by default (clauses i, iii and iv).
	it.each([
		["no recorded provenance (a legacy or foreign writer)", undefined, "census_unknown"],
		[
			"a verified session of another kernel on a non-local daemon directory",
			{ kernelSession: S2, directoryLocal: false },
			"census_unknown",
		],
		[
			"an unverified session on a non-local daemon directory",
			{ kernelSession: null, directoryLocal: false },
			"census_unknown",
		],
		[
			"its own verified session equal to the prober's",
			{ kernelSession: FAKE_KERNEL_SESSION, directoryLocal: false },
			"recovered",
		],
		[
			"an unverified session on a daemon directory recorded local and local now",
			{ kernelSession: null, directoryLocal: true },
			"recovered",
		],
	] as const)("census rows: an absent PID in a row with %s", async (_label, provenance, expected) => {
		const machine = fakeWindows();
		const launch = await launched(machine);
		crash(machine);
		const instance = provenance
			? await provenanced(launch, "other-generation", provenance)
			: generationPaths(launch.paths, "other-generation");
		await mkdir(instance.dir, { recursive: true });
		await writeFile(instance.pidFile, JSON.stringify({ pid: 6262, processStartTime: "134000000000000060" }));
		const outcome = await recover(launch, machine);
		expect(outcome.status === "refused" ? outcome.reason : outcome.status).toBe(expected);
	});

	it("census rows: a daemon directory recorded local but not local now keeps its rows gated", async () => {
		const machine = fakeWindows({ kernelSession: null });
		const launch = await launched(machine);
		crash(machine);
		const instance = await provenanced(launch, "other-generation", { kernelSession: null, directoryLocal: true });
		await writeFile(instance.pidFile, JSON.stringify({ pid: 6262, processStartTime: "134000000000000060" }));
		machine.control.directoryLocality.set(launch.paths.dir, "not_local");
		expect(await recover(launch, machine)).toMatchObject({ status: "refused", reason: "census_unknown" });
	});

	it("census rows: the generation's own supervisor row is discharged by the supervisor's released commit even while that process lives on", async () => {
		const machine = fakeWindows();
		const launch = await launched(machine);
		// The row the reserving owner wrote for the supervisor it spawned, under the generation it launched.
		const instance = await provenanced(launch, "this-generation", {
			kernelSession: FAKE_KERNEL_SESSION,
			directoryLocal: true,
		});
		await writeFile(instance.pidFile, JSON.stringify(SUPERVISOR));
		// The supervisor quiesced: it committed its released and closed its guard, and stays alive doing unrelated work.
		launch.store.release(launch.generation, "supervisor", JSON.stringify(SUPERVISOR));
		crash(machine);
		const processes = fakeProcessTable();
		processes.live(SUPERVISOR.pid, SUPERVISOR.processStartTime);
		expect(await recover(launch, machine, processes)).toMatchObject({ status: "recovered" });
		expect(processes.observed).not.toContain(SUPERVISOR.pid);
	});

	// senpi#4479 MEDIUM 2: incomplete discovery remains unknown (design 4.2a).
	it.each([
		[
			"an unreadable generations directory",
			async (launch: Awaited<ReturnType<typeof launched>>) => {
				await rm(launch.paths.generationsDir, { recursive: true, force: true });
				await mkdir(launch.paths.dir, { recursive: true });
				await writeFile(launch.paths.generationsDir, "not a directory");
			},
		],
		[
			"an unreadable generation pidfile",
			async (launch: Awaited<ReturnType<typeof launched>>) => {
				const instance = generationPaths(launch.paths, "other-generation");
				await mkdir(instance.dir, { recursive: true });
				await writeFile(instance.pidFile, JSON.stringify({ pid: 6262, processStartTime: "134000000000000060" }));
				await chmod(instance.pidFile, 0o000);
			},
		],
		[
			"a half-written session claim",
			async (launch: Awaited<ReturnType<typeof launched>>) => {
				await mkdir(launch.paths.reservationsDir, { recursive: true });
				await writeFile(join(launch.paths.reservationsDir, "claim.json"), '{"instanceId":"x","pid":');
			},
		],
		[
			"an unreadable reservations directory",
			async (launch: Awaited<ReturnType<typeof launched>>) => {
				await mkdir(launch.paths.dir, { recursive: true });
				await writeFile(launch.paths.reservationsDir, "not a directory");
			},
		],
	] as const)("incomplete discovery: %s is unknown, never nothing to find", async (_label, damage) => {
		const machine = fakeWindows();
		const launch = await launched(machine);
		crash(machine);
		await damage(launch);
		expect(await recover(launch, machine)).toMatchObject({ status: "refused", reason: "census_unknown" });
		expect(launch.store.activeGenerations(ENDPOINT)).toEqual([launch.generation]);
	});

	it("test 29 clause (iii): a local-store row needs no kernel session; reopened-PID absence is gone there", async () => {
		const machine = fakeWindows({ kernelSession: null });
		const launch = await launched(machine);
		crash(machine);
		const owner = launch.store.reservation(launch.generation).ownerPresence;
		if (owner.status !== "predeclared") throw new Error("expected an object");
		machine.objects.delete(owner.path);
		expect(await recover(launch, machine)).toMatchObject({ status: "recovered" });
		expect(launch.store.reservation(launch.generation).retirement?.discharges.owner).toBe("process_gone");
	});
});
