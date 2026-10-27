import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHostArgs } from "../../../src/cli/host-command.ts";
import {
	type EndpointReservationStore,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import {
	OBSERVATION_BUDGET_MS,
	type RecoveryClock,
	type RecoveryOutcome,
	recoverEndpointReservations,
	recoveryProber,
} from "../../../src/modes/rpc/endpoint-recovery.ts";
import { repairEndpointReservations } from "../../../src/modes/rpc/endpoint-repair.ts";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { recordLaunchProvenance } from "../../../src/modes/rpc/launch-provenance.ts";
import {
	acquireOwnerPresence,
	claimLaunchRole,
	credentialCommitment,
	grantVerifiedParticipant,
	type LaunchIdentity,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
	reservationStorePath,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { HOST_EXIT_REFUSED, runHostRequest } from "../../../src/modes/rpc/host-runner.ts";
import { resolvePresenceRoot } from "../../../src/modes/rpc/presence-placement.ts";
import { createSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import type { ProcessIdentityResult } from "../../../src/utils/process-identity.ts";
import { FAKE_KERNEL_SESSION, fakeProcessTable, fakeWindows } from "../../helpers/fake-windows-presence.ts";

const mocked = vi.hoisted(() => ({
	lockDir: "",
	placement: undefined as unknown,
}));

vi.mock("../../../src/modes/rpc/socket-secret-native.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/socket-secret-native.ts")>();
	return {
		...actual,
		// Every bridge in this file is passed explicitly, or installed for the CLI case; never the real (absent) one.
		loadPresencePlacement: vi.fn(() =>
			mocked.placement === undefined ? { status: "unavailable", reason: "native_unavailable" } : mocked.placement,
		),
	};
});

vi.mock("../../../src/modes/rpc/host-ensure-lock.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-ensure-lock.ts")>()),
	hostEnsureLockTarget: () => join(mocked.lockDir, "endpoint"),
	// The CLI case runs on a POSIX path under a stubbed win32 platform; the lock itself is not under test here.
	acquireHostEnsureLock: async () => async () => {},
}));

vi.mock("../../../src/utils/process-identity.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/utils/process-identity.ts")>();
	return {
		...actual,
		// The CLI case runs under a stubbed win32 platform, where the bridge is the evidence source; the start-time reader
		// must never reach PowerShell there, and whatever still asks it sees no process.
		readProcessIdentity: vi.fn(async (): Promise<ProcessIdentityResult> => ({ kind: "absent" })),
	};
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Bounded unknown
// escalation", Revision 6 "Bounded recovery" and "Fresh evidence after escalation", "Visible Repair connection action",
// Revision 7 "Repair amendments" ("Busy owner first", "Restart only where it proves something", "Foreign or host-gone
// rows"), Revision 8 r7 note 4; tests 12, 20 and 26, engine half). Security contract: an unknown recorded identity gets at
// most two observations inside the smaller of the caller's deadline and five seconds, then a durable escalated reason
// on the reservation and a typed recovery-required result that names the reason and the Repair action; an unchanged
// record answers a later automatic caller from that marker without a new query, while its independent presence and boot
// evidence is still checked once per invocation; only an explicit repair opens one new bounded assessment. A late query
// result mutates nothing. The restart action is offered only for a local-store endpoint, behind a repair anchor that
// records the current verified kernel session at the fenced generation/revision; a non-local store names the recorded
// host and session instead. A busy owner is waited for with the bridge's blocking wait, never a deadline, and the handle
// that acquires in that wait is the recovery guard for that object: never closed and reacquired before the check, held
// through the retirement commit, released at once when the check cannot retire, and cancelled by dismissal without
// releasing anything the wait did not acquire.
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

/** A monotonic clock the test drives, with the deadline as an explicit event rather than elapsed time. */
function fakeClock() {
	let now = 0;
	const armed: { readonly at: number; readonly resolve: () => void }[] = [];
	const listeners: (() => void)[] = [];
	const clock: RecoveryClock = {
		now: () => now,
		deadline: (ms) =>
			new Promise<void>((resolve) => {
				armed.push({ at: now + ms, resolve });
				for (const listener of listeners.splice(0)) listener();
			}),
	};
	return {
		clock,
		/** Resolves once the attempt has armed its deadline: the barrier registered before the trigger. */
		armed: () => new Promise<void>((resolve) => (armed.length > 0 ? resolve() : listeners.push(resolve))),
		advance(ms: number) {
			now += ms;
			const due = armed.filter((entry) => entry.at <= now);
			armed.splice(0, armed.length, ...armed.filter((entry) => entry.at > now));
			for (const entry of due) entry.resolve();
		},
		/** The explicit deadline event. */
		fire() {
			for (const entry of armed.splice(0)) entry.resolve();
		},
	};
}

describe("#4199 bounded escalation and the Repair result (tests 12, 20 and 26, engine half)", () => {
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
		const root = await mkdtemp(join(tmpdir(), "rpc4199-escalation-"));
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
	async function launched(machine: Machine, owner: LaunchIdentity = OWNER, root?: string) {
		root ??= await tempRoot();
		// The endpoint's fixed store beside its (mocked) ensure lock: the one store a claimant's locator may name.
		mocked.lockDir = root;
		const storePath = reservationStorePath(ENDPOINT);
		const store = await openStore(storePath);
		const socket = join(root, "rpc.sock");
		const reservation = resolvePresenceRoot({
			coordinationTarget: TARGET,
			endpointKey: ENDPOINT_KEY,
			native: machine.load,
		});
		const ownerPresence = acquireOwnerPresence(reservation, machine.load);
		const { generation, args } = offerSupervisorLaunch(store, ENDPOINT, owner, {
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
			owner,
			SUPERVISOR,
			credentialCommitment(SECRET, "supervisor", socketSecretPath(ENDPOINT)),
		);
		const paths = await createHostDaemonPaths({ agentDir: join(root, "agent"), socket });
		const ownerObject = store.reservation(generation).ownerPresence;
		const supervisorObject = store.roleRow(locator)?.presence;
		if (ownerObject.status !== "predeclared" || supervisorObject?.status !== "predeclared") {
			throw new Error("expected predeclared objects");
		}
		const objects = { owner: ownerObject, supervisor: supervisorObject };
		return { root, storePath, store, socket, generation, locator, paths, objects };
	}

	type Launch = Awaited<ReturnType<typeof launched>>;

	/** Process death: the kernel closes every handle the dead processes held, so their locks are free. */
	function crash(machine: Machine) {
		machine.held.clear();
	}

	/** The owner's object is gone, so only the exact process proof can discharge its entry (test 19). */
	function ownerObjectMissing(launch: Launch, machine: Machine) {
		machine.objects.delete(launch.objects.owner.path);
	}

	/**
	 * A census row of an earlier generation, with the launch provenance its reserving owner recorded beside it (senpi#4479
	 * fold): `session` is that owner's kernel session at the launch (`null` = unverified), on the local daemon directory.
	 */
	async function censusEntry(
		launch: Launch,
		pid: number,
		processStartTime = "134000000000000005",
		session: string | null = FAKE_KERNEL_SESSION,
	) {
		const instance = generationPaths(launch.paths, "old-generation");
		await mkdir(instance.dir, { recursive: true });
		await recordLaunchProvenance(instance.launchProvenanceFile, {
			generation: launch.generation,
			kernelSession:
				session === null
					? { status: "unverified", reason: "access_denied" }
					: { status: "verified", value: session },
			directoryLocal: true,
		});
		await writeFile(instance.pidFile, JSON.stringify({ pid, processStartTime }));
	}

	function recover(
		launch: Launch,
		machine: Machine,
		processes = fakeProcessTable(),
		options: { clock?: RecoveryClock; remainingMs?: number; fresh?: boolean } = {},
	) {
		return recoverEndpointReservations(
			launch.store,
			ENDPOINT,
			launch.paths,
			recoveryProber(STORE_DIR, machine.load, {
				observe: processes.observe,
				daemonDirectory: launch.paths.dir,
				...options,
			}),
		);
	}

	function probes(machine: Machine, presenceId?: string) {
		return machine.calls.filter((call) => call.startsWith(`presenceProbe ${presenceId ?? ""}`));
	}

	function refused(outcome: RecoveryOutcome) {
		if (outcome.status !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
		return outcome;
	}

	describe("test 12: unreadable identity and bounded escalation", () => {
		it("denied access: at most two observations inside the budget, then a durable escalated reason and the typed result", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			ownerObjectMissing(launch, machine);
			const processes = fakeProcessTable();
			processes.denied(OWNER.pid);
			const { clock } = fakeClock();
			const outcome = refused(await recover(launch, machine, processes, { clock }));
			expect(outcome).toMatchObject({
				reason: "authority_unknown",
				generation: launch.generation,
				action: "restart_computer",
				escalation: { reason: "owner_identity_unreadable", observations: 2, cached: false },
			});
			// The initial observation and exactly one fresh requery, nothing more.
			expect(processes.observed).toEqual([OWNER.pid, OWNER.pid]);
			const reservation = launch.store.reservation(launch.generation);
			expect(reservation.state).toBe("cancelling");
			expect(reservation.escalation).toEqual({
				revision: reservation.revision,
				subject: "owner",
				reason: "owner_identity_unreadable",
				observations: 2,
			});
			// Nothing retired, deleted or recreated.
			expect(launch.store.activeGenerations(ENDPOINT)).toEqual([launch.generation]);
			expect(machine.objects.has(launch.objects.owner.path)).toBe(false);
			expect(machine.objects.has(launch.objects.supervisor.path)).toBe(true);
		});

		it("the shorter caller deadline: the explicit deadline event ends the attempt after one observation, and a late result cannot retire", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			ownerObjectMissing(launch, machine);
			let late!: (result: ProcessIdentityResult) => void;
			const observed: number[] = [];
			const observe = (pid: number) => {
				observed.push(pid);
				return new Promise<ProcessIdentityResult>((resolve) => {
					late = resolve;
				});
			};
			const { clock, armed, fire } = fakeClock();
			const remainingMs = 1_000;
			expect(remainingMs).toBeLessThan(OBSERVATION_BUDGET_MS);
			const attempt = recoverEndpointReservations(
				launch.store,
				ENDPOINT,
				launch.paths,
				recoveryProber(STORE_DIR, machine.load, { observe, clock, remainingMs, daemonDirectory: launch.paths.dir }),
			);
			await armed();
			fire();
			const outcome = refused(await attempt);
			expect(outcome).toMatchObject({
				reason: "authority_unknown",
				escalation: { reason: "owner_identity_unreadable", observations: 1, cached: false },
			});
			expect(observed).toEqual([OWNER.pid]);
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
			// The query answers after the attempt ended: it cannot retire, grant or spawn anything.
			late({ kind: "absent" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
			expect(launch.store.activeGenerations(ENDPOINT)).toEqual([launch.generation]);
		});

		it("the budget is the smaller of the caller's deadline and five seconds: an expired budget skips the requery", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			ownerObjectMissing(launch, machine);
			const { clock, advance } = fakeClock();
			const processes = fakeProcessTable();
			const observe = processes.observe;
			processes.observe = async (pid) => {
				// The first observation alone consumed the whole budget.
				advance(OBSERVATION_BUDGET_MS);
				return observe(pid);
			};
			processes.denied(OWNER.pid);
			const outcome = refused(await recover(launch, machine, processes, { clock, remainingMs: 60_000 }));
			expect(outcome.escalation).toEqual({ reason: "owner_identity_unreadable", observations: 1, cached: false });
			expect(processes.observed).toEqual([OWNER.pid]);
		});

		it("a later automatic caller sees the same escalation without a new query, while its presence census still runs; an explicit repair opens one new bounded assessment", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			ownerObjectMissing(launch, machine);
			const processes = fakeProcessTable();
			processes.denied(OWNER.pid);
			refused(await recover(launch, machine, processes));
			expect(processes.observed).toHaveLength(2);
			machine.calls.length = 0;
			const again = refused(await recover(launch, machine, processes));
			expect(again).toMatchObject({
				reason: "authority_unknown",
				action: "restart_computer",
				escalation: { reason: "owner_identity_unreadable", observations: 0, cached: true },
			});
			// The unchanged marker suppressed the query, not the independent presence evidence (Revision 6): the owner's
			// missing object was probed again (and the supervisor's too when presence-ID order put it first).
			expect(processes.observed).toHaveLength(2);
			expect(probes(machine, launch.objects.owner.presenceId)).toHaveLength(1);
			expect(probes(machine, launch.objects.supervisor.presenceId).length).toBeLessThanOrEqual(1);
			// Explicit repair: one new bounded assessment, still at most two observations.
			const repaired = refused(await recover(launch, machine, processes, { fresh: true }));
			expect(repaired.escalation).toEqual({ reason: "owner_identity_unreadable", observations: 2, cached: false });
			expect(processes.observed).toHaveLength(4);
		});

		it("a record that changed after the escalation gets a fresh budget", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			ownerObjectMissing(launch, machine);
			const processes = fakeProcessTable();
			processes.denied(OWNER.pid);
			refused(await recover(launch, machine, processes));
			const other = await openStore(launch.storePath);
			other.release(launch.generation, "supervisor", JSON.stringify(SUPERVISOR));
			const outcome = refused(await recover(launch, machine, processes));
			expect(outcome.escalation).toMatchObject({ observations: 2, cached: false });
			expect(processes.observed).toHaveLength(4);
		});

		it.each([
			[
				"a missing stored discriminator is owner_identity_incomplete",
				{
					owner: { pid: 100, processStartTime: null },
					observation: "live" as const,
					reason: "owner_identity_incomplete",
				},
			],
			[
				"a noncomparable observed identity is owner_identity_incomplete",
				{ owner: OWNER, observation: "unparsable" as const, reason: "owner_identity_incomplete" },
			],
		])("%s", async (_label, options) => {
			const machine = fakeWindows();
			const launch = await launched(machine, options.owner);
			crash(machine);
			ownerObjectMissing(launch, machine);
			const processes = fakeProcessTable();
			if (options.observation === "live") processes.live(OWNER.pid, "134000000000000009");
			else processes.table.set(OWNER.pid, { kind: "present", identity: "not-a-filetime" });
			const outcome = refused(await recover(launch, machine, processes));
			expect(outcome).toMatchObject({
				reason: "authority_unknown",
				escalation: { reason: options.reason, cached: false },
			});
			expect(launch.store.reservation(launch.generation).escalation?.reason).toBe(options.reason);
		});

		it.each([
			["verified but different kernel sessions", S1, S2, "owner_identity_domain_mismatch"],
			["an unverified recorded session", null, S2, "owner_identity_domain_unverified"],
			["an unverified current session", S1, null, "owner_identity_domain_unverified"],
			["both unverified", null, null, "owner_identity_domain_unverified"],
		])("the kernel-session gate: %s", async (_label, recorded, prober, reason) => {
			const machine = fakeWindows({ storeLocality: "not_local", kernelSession: recorded });
			const launch = await launched(machine);
			crash(machine);
			ownerObjectMissing(launch, machine);
			machine.control.kernelSession =
				prober === null
					? { status: "unverified", creationTime: null, reason: "access_denied" }
					: { status: "verified", creationTime: prober, reason: null };
			const processes = fakeProcessTable();
			const outcome = refused(await recover(launch, machine, processes));
			expect(outcome).toMatchObject({
				reason: "authority_unknown",
				action: "resolve_on_recorded_host",
				escalation: { reason, observations: 0, cached: false },
				// Whichever probe-set entry (presence-ID order) the gate stopped at; both rows recorded that session.
				holder: { entry: expect.stringMatching(/^(owner|supervisor)$/), kernelSession: recorded },
			});
			// The gate decides before any query.
			expect(processes.observed).toEqual([]);
		});

		it("resolved to a matching live owner still refuses; resolved to gone, it retires only with the complete census", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			ownerObjectMissing(launch, machine);
			const processes = fakeProcessTable();
			processes.denied(OWNER.pid);
			refused(await recover(launch, machine, processes));
			processes.live(OWNER.pid, OWNER.processStartTime);
			expect(await recover(launch, machine, processes, { fresh: true })).toMatchObject({
				status: "refused",
				reason: "authority_live",
				action: "drain_owner",
			});
			processes.table.delete(OWNER.pid);
			await censusEntry(launch, 4343);
			processes.live(4343, "134000000000000005");
			expect(await recover(launch, machine, processes, { fresh: true })).toMatchObject({
				status: "refused",
				reason: "census_live",
				action: "drain_owner",
			});
			processes.table.delete(4343);
			expect(await recover(launch, machine, processes)).toMatchObject({ status: "recovered" });
			expect(launch.store.reservation(launch.generation).retirement?.discharges.owner).toBe("process_gone");
		});
	});

	// --- senpi#4481 review folds -------------------------------------------------------------------------------------
	describe("senpi#4481 folds: the prior-boot proof and the anchor observe before they resolve; the marker answers its own subject only", () => {
		/** Every row written in session S1 on a local store, then a confirmed reboot to S2 with every local actor gone. */
		async function rebooted() {
			const machine = fakeWindows({ kernelSession: S1 });
			const launch = await launched(machine);
			crash(machine);
			machine.control.kernelSession = { status: "verified", creationTime: S2, reason: null };
			return { machine, launch };
		}

		it("HIGH: a proven prior boot never marks a census entry gone without observing it; a live entry blocks", async () => {
			const { machine, launch } = await rebooted();
			// A row of the prior boot (session S1), as the generation's own rows are.
			await censusEntry(launch, 4343, "134000000000000005", S1);
			const processes = fakeProcessTable();
			// A current-boot process at that PID with the recorded creation time: it is live, whatever the reboot proved.
			processes.live(4343, "134000000000000005");
			expect(await recover(launch, machine, processes)).toMatchObject({ status: "refused", reason: "census_live" });
			expect(processes.observed).toContain(4343);
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
		});

		it("HIGH: a repair anchor never marks a census entry gone without observing it; a live entry blocks", async () => {
			const machine = fakeWindows({ kernelSession: null });
			const launch = await launched(machine);
			crash(machine);
			await censusEntry(launch, 4343, "134000000000000005", null);
			const processes = fakeProcessTable();
			processes.denied(4343);
			machine.control.kernelSession = { status: "verified", creationTime: S1, reason: null };
			const anchored = await repairEndpointReservations({
				store: launch.store,
				endpoint: ENDPOINT,
				paths: launch.paths,
				prober: recoveryProber(STORE_DIR, machine.load, {
					observe: processes.observe,
					daemonDirectory: launch.paths.dir,
				}),
				withEndpointLock: (run) => run(),
				confirmRestart: true,
			});
			expect(anchored).toMatchObject({ status: "refused", reason: "census_unknown", action: "restart_computer" });
			// After the restart the entry's process is live again (a current-boot writer): the anchor proves nothing for it.
			machine.control.kernelSession = { status: "verified", creationTime: S2, reason: null };
			processes.live(4343, "134000000000000005");
			expect(await recover(launch, machine, processes)).toMatchObject({ status: "refused", reason: "census_live" });
			expect(processes.observed).toContain(4343);
		});

		it("MEDIUM: an unchanged escalation marker answers only the entry it was recorded for; every other entry is queried", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			// The presence store is denied: every acquisition is an access-denied open, the owner's identity is denied too.
			machine.control.probeOutcome = { status: "unknown", reason: "os_error", code: 5 };
			const processes = fakeProcessTable();
			processes.denied(OWNER.pid);
			processes.denied(SUPERVISOR.pid);
			const first = refused(await recover(launch, machine, processes));
			expect(first).toMatchObject({ reason: "authority_unknown", action: "restore_store_access" });
			expect(launch.store.reservation(launch.generation).escalation?.subject).toMatch(/^(owner|supervisor)$/);
			// Access restored: every authority entry acquires (presence_released); a census entry never escalated is absent.
			machine.control.probeOutcome = undefined;
			await censusEntry(launch, 4343, "134000000000000005");
			const before = processes.observed.length;
			expect(await recover(launch, machine, processes)).toMatchObject({ status: "recovered" });
			expect(processes.observed.slice(before)).toContain(4343);
		});

		it("LOW: the marker is stamped at the revision the attempt read; a record that changed meanwhile gets no stale marker and a fresh budget", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			crash(machine);
			ownerObjectMissing(launch, machine);
			const processes = fakeProcessTable();
			processes.denied(OWNER.pid);
			const other = await openStore(launch.storePath);
			const observe = processes.observe;
			let committed = false;
			processes.observe = async (pid) => {
				// A participant commits released between this attempt's read and its marker write.
				if (!committed) {
					committed = true;
					other.release(launch.generation, "supervisor", JSON.stringify(SUPERVISOR));
				}
				return observe(pid);
			};
			const first = refused(await recover(launch, machine, processes));
			expect(first.reason).toMatch(/^(authority_unknown|revision_changed)$/);
			const reservation = launch.store.reservation(launch.generation);
			// Either no marker, or one that is not valid at the current revision: never a marker describing the old record
			// that is valid now.
			expect(reservation.escalation === null || reservation.escalation.revision !== reservation.revision).toBe(true);
			processes.observe = observe;
			const next = refused(await recover(launch, machine, processes));
			expect(next).toMatchObject({ reason: "authority_unknown", escalation: { observations: 2, cached: false } });
		});
	});

	describe("test 20 (engine half): the typed Repair action and the repair anchor", () => {
		it("a denied presence store is restore_store_access; a local-store endpoint offers the restart; a non-local store names the recorded host and session", async () => {
			const local = fakeWindows();
			const launchLocal = await launched(local);
			crash(local);
			ownerObjectMissing(launchLocal, local);
			const denied = fakeProcessTable();
			denied.denied(OWNER.pid);
			expect(refused(await recover(launchLocal, local, denied)).action).toBe("restart_computer");

			local.control.probeOutcome = { status: "unknown", reason: "os_error", code: 5 };
			expect(refused(await recover(launchLocal, local, denied, { fresh: true }))).toMatchObject({
				reason: "authority_unknown",
				action: "restore_store_access",
			});

			const relocated = fakeWindows({ storeLocality: "not_local", kernelSession: S1 });
			const launchRelocated = await launched(relocated);
			crash(relocated);
			ownerObjectMissing(launchRelocated, relocated);
			relocated.control.kernelSession = { status: "verified", creationTime: S2, reason: null };
			expect(refused(await recover(launchRelocated, relocated, denied))).toMatchObject({
				action: "resolve_on_recorded_host",
				holder: {
					entry: expect.stringMatching(/^(owner|supervisor)$/),
					hostLabel: expect.any(String),
					kernelSession: S1,
				},
			});
		});

		it("a busy owner is wait_for_owner, a live owner drain_owner, a changed revision retry", async () => {
			const machine = fakeWindows();
			const launch = await launched(machine);
			// The owner exited; its granted supervisor still holds its object.
			machine.held.delete(launch.objects.owner.path);
			expect(refused(await recover(launch, machine))).toMatchObject({
				reason: "presence_occupied",
				action: "wait_for_owner",
				holder: { entry: "supervisor" },
			});
		});

		it("a confirmed restart persists the anchor at the fenced generation and revision, in the current verified session", async () => {
			// The owner's session could not be read when it reserved: the anchor is the only boot provenance these rows get.
			const machine = fakeWindows({ kernelSession: null });
			const launch = await launched(machine);
			crash(machine);
			await censusEntry(launch, 4242, "134000000000000005", null);
			const processes = fakeProcessTable();
			processes.denied(4242);
			machine.control.kernelSession = { status: "verified", creationTime: S1, reason: null };
			const outcome = await repairEndpointReservations({
				store: launch.store,
				endpoint: ENDPOINT,
				paths: launch.paths,
				prober: recoveryProber(STORE_DIR, machine.load, {
					observe: processes.observe,
					daemonDirectory: launch.paths.dir,
				}),
				withEndpointLock: (run) => run(),
				confirmRestart: true,
			});
			expect(outcome).toMatchObject({
				status: "refused",
				reason: "census_unknown",
				action: "restart_computer",
				escalation: { reason: "owner_identity_unreadable", observations: 2 },
			});
			const reservation = launch.store.reservation(launch.generation);
			expect(outcome.status === "refused" && outcome.anchor).toEqual({
				revision: reservation.revision,
				kernelSession: S1,
			});
			expect(reservation.repairAnchor).toEqual({ revision: reservation.revision, kernelSession: S1 });
			// Cancelling the OS action leaves everything intact: the same session is no proof.
			expect(await recover(launch, machine, processes)).toMatchObject({
				status: "refused",
				reason: "census_unknown",
			});
			expect(processes.observed).toHaveLength(2);
			// A confirmed subsequent kernel boot: the anchor proves every process of the anchored session gone.
			machine.control.kernelSession = { status: "verified", creationTime: S2, reason: null };
			expect(await recover(launch, machine, processes)).toMatchObject({ status: "recovered" });
			expect(launch.store.reservation(launch.generation).retirement?.discharges).toEqual({
				owner: "presence_released",
				supervisor: "presence_released",
			});
		});

		it("an anchor is not recorded without a verified session, and a stale anchor (changed revision) proves nothing", async () => {
			const unverified = fakeWindows({ kernelSession: null });
			const launchUnverified = await launched(unverified);
			crash(unverified);
			await censusEntry(launchUnverified, 4242, "134000000000000005", null);
			const processes = fakeProcessTable();
			processes.denied(4242);
			const refusedUnverified = await repairEndpointReservations({
				store: launchUnverified.store,
				endpoint: ENDPOINT,
				paths: launchUnverified.paths,
				prober: recoveryProber(STORE_DIR, unverified.load, {
					observe: processes.observe,
					daemonDirectory: launchUnverified.paths.dir,
				}),
				withEndpointLock: (run) => run(),
				confirmRestart: true,
			});
			expect(refusedUnverified).toMatchObject({ status: "refused", action: "restart_computer", anchor: null });
			expect(launchUnverified.store.reservation(launchUnverified.generation).repairAnchor).toBeNull();

			const stale = fakeWindows({ kernelSession: null });
			const launchStale = await launched(stale);
			crash(stale);
			await censusEntry(launchStale, 4242, "134000000000000005", null);
			stale.control.kernelSession = { status: "verified", creationTime: S1, reason: null };
			await repairEndpointReservations({
				store: launchStale.store,
				endpoint: ENDPOINT,
				paths: launchStale.paths,
				prober: recoveryProber(STORE_DIR, stale.load, {
					observe: processes.observe,
					daemonDirectory: launchStale.paths.dir,
				}),
				withEndpointLock: (run) => run(),
				confirmRestart: true,
			});
			expect(launchStale.store.reservation(launchStale.generation).repairAnchor).not.toBeNull();
			// A later claim or commit changed the generation after the anchor: the anchor no longer describes it.
			const other = await openStore(launchStale.storePath);
			other.release(launchStale.generation, "supervisor", JSON.stringify(SUPERVISOR));
			stale.control.kernelSession = { status: "verified", creationTime: S2, reason: null };
			expect(await recover(launchStale, stale, processes)).toMatchObject({
				status: "refused",
				reason: "census_unknown",
				action: "restart_computer",
			});
		});

		it("a non-local store never records an anchor and never offers the restart", async () => {
			const machine = fakeWindows({ storeLocality: "not_local", kernelSession: S1 });
			const launch = await launched(machine);
			crash(machine);
			ownerObjectMissing(launch, machine);
			machine.control.kernelSession = { status: "verified", creationTime: S2, reason: null };
			const outcome = await repairEndpointReservations({
				store: launch.store,
				endpoint: ENDPOINT,
				paths: launch.paths,
				prober: recoveryProber(STORE_DIR, machine.load, { observe: fakeProcessTable().observe }),
				withEndpointLock: (run) => run(),
				confirmRestart: true,
			});
			expect(outcome).toMatchObject({ status: "refused", action: "resolve_on_recorded_host" });
			expect(outcome.status === "refused" && outcome.anchor).toBeUndefined();
			expect(launch.store.reservation(launch.generation).repairAnchor).toBeNull();
		});

		it("the `host repair` request carries the typed result and the anchor; `host repair --confirm-restart --json` parses", async () => {
			expect(parseHostArgs(["repair", "--socket", "C:\\x\\rpc.sock", "--confirm-restart", "--json"])).toMatchObject({
				subcommand: "repair",
				socket: "C:\\x\\rpc.sock",
				confirmRestart: true,
				json: true,
			});
			const machine = fakeWindows();
			const root = await tempRoot();
			mocked.lockDir = root;
			mocked.placement = machine.load;
			const socket = join(root, "rpc.sock");
			await createSocketSecret(socketSecretPath(socket));
			const target = join(root, "endpoint");
			const store = await openStore(`${target}.reservation.db`);
			const reservation = resolvePresenceRoot({
				coordinationTarget: target,
				endpointKey: basename(target),
				native: machine.load,
			});
			const ownerPresence = acquireOwnerPresence(reservation, machine.load);
			const { generation, args } = offerSupervisorLaunch(store, socket, OWNER, {
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
				credentialCommitment(SECRET, "supervisor", socketSecretPath(socket)),
			);
			const agentDir = join(root, "agent");
			await createHostDaemonPaths({ agentDir, socket });
			crash(machine);
			const owner = store.reservation(generation).ownerPresence;
			if (owner.status !== "predeclared") throw new Error("expected an object");
			machine.objects.delete(owner.path);
			// On Windows the CLI's recovery observes through the bridge's retained-handle adapter: a denied `OpenProcess`.
			machine.processes.denied(OWNER.pid);
			vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
			const outcome = await runHostRequest({ action: "repair", target: { socket, agentDir }, confirmRestart: true });
			vi.unstubAllGlobals();
			expect(outcome.exitCode).toBe(HOST_EXIT_REFUSED);
			expect(outcome.payload).toMatchObject({
				action: "refuse",
				reason: "reservation_recovery_required",
				socket,
				recovery: {
					reason: "authority_unknown",
					generation,
					action: "restart_computer",
					escalation: { reason: "owner_identity_unreadable", observations: 2, cached: false },
				},
				anchor: { revision: store.reservation(generation).revision, kernelSession: FAKE_KERNEL_SESSION },
			});
			expect(store.reservation(generation).escalation?.reason).toBe("owner_identity_unreadable");
		});
	});

	describe("test 26 (engine half): the busy-owner wait and its retained guard", () => {
		/** The reserving owner crashed; its granted supervisor is alive, paused before bind, and still holds its object. */
		async function supervisorHeld(options: Parameters<typeof fakeWindows>[0] = {}) {
			const waits: string[] = [];
			const machine = fakeWindows({ ...options, onWait: (request) => waits.push(request.presenceId) });
			const launch = await launched(machine);
			machine.held.delete(launch.objects.owner.path);
			return { machine, launch, waits };
		}

		function repair(
			launch: Launch,
			machine: Machine,
			options: {
				processes?: ReturnType<typeof fakeProcessTable>;
				signal?: AbortSignal;
				lock?: { held: boolean };
			} = {},
		) {
			const lock = options.lock ?? { held: false };
			return repairEndpointReservations({
				store: launch.store,
				endpoint: ENDPOINT,
				paths: launch.paths,
				prober: recoveryProber(STORE_DIR, machine.load, {
					observe: (options.processes ?? fakeProcessTable()).observe,
				}),
				withEndpointLock: async (run) => {
					lock.held = true;
					try {
						return await run();
					} finally {
						lock.held = false;
					}
				},
				signal: options.signal,
			});
		}

		it("busy owner first: the wait holds no lock and no transaction; the fake release event, not a poll, triggers the bounded check and automatic recovery with the wait's handle as the retained guard", async () => {
			const { machine, launch, waits } = await supervisorHeld();
			const supervisor = launch.objects.supervisor;
			const lock = { held: false };
			const order: string[] = [];
			const release = machine.native.presenceReleaseAfterQuiescence;
			vi.spyOn(machine.native, "presenceReleaseAfterQuiescence").mockImplementation((receipt) => {
				order.push(`release ${receipt.presenceId} while ${launch.store.reservation(launch.generation).state}`);
				return release(receipt);
			});
			const outcome = repair(launch, machine, { lock });
			await vi.waitFor(() => expect(waits).toEqual([supervisor.presenceId]));
			// The worker waits outside the endpoint lock and every state transaction.
			expect(lock.held).toBe(false);
			const other = new DatabaseSync(launch.storePath);
			try {
				other.exec("BEGIN IMMEDIATE; ROLLBACK;");
			} finally {
				other.close();
			}
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
			// The first check released at once what it acquired (the owner's free object, when presence-ID order probed
			// it before the held one), since it could not retire; it released nothing after that.
			expect(new Set(order).size).toBe(order.length);
			for (const release of order)
				expect(release).toBe(`release ${launch.objects.owner.presenceId} while cancelling`);
			order.length = 0;
			machine.calls.length = 0;
			// The holder idle-exits: the kernel releases its lock, and the bridge's blocking wait acquires.
			machine.releaseHeld(supervisor.path);
			expect(await outcome).toEqual({ status: "recovered", generations: [launch.generation] });
			// Exactly one wait, no polling, and the wait's handle was never closed and reacquired before the check.
			expect(waits).toEqual([supervisor.presenceId]);
			expect(probes(machine, supervisor.presenceId)).toEqual([]);
			expect(probes(machine, launch.objects.owner.presenceId)).toHaveLength(1);
			expect(order.sort()).toEqual(
				[
					`release ${launch.objects.owner.presenceId} while retired`,
					`release ${supervisor.presenceId} while retired`,
				].sort(),
			);
			expect(machine.held.size).toBe(0);
			expect(launch.store.reservation(launch.generation).retirement?.discharges).toEqual({
				owner: "presence_released",
				supervisor: "presence_released",
			});
		});

		it("another invocation's probe during the check sees the object busy", async () => {
			const { machine, launch } = await supervisorHeld();
			const supervisor = launch.objects.supervisor;
			await censusEntry(launch, 5151);
			const processes = fakeProcessTable();
			const observe = processes.observe;
			const seen: string[] = [];
			processes.observe = async (pid) => {
				// Another prober, while Repair's check runs its census holding the wait's handle.
				const probe = machine.native.presenceProbe({
					presenceId: supervisor.presenceId,
					path: supervisor.path,
					header: Buffer.from(supervisor.header, "hex"),
					volumeSerial: supervisor.volumeSerial,
					fileId: supervisor.fileId,
					createdLocal: true,
					relocated: false,
					kernelSession: null,
				});
				seen.push(probe.status);
				return observe(pid);
			};
			const outcome = repair(launch, machine, { processes });
			await vi.waitFor(() => expect(machine.waits.size).toBe(1));
			machine.releaseHeld(supervisor.path);
			expect(await outcome).toMatchObject({ status: "recovered" });
			expect(seen).toEqual(["occupied"]);
		});

		it("the guard is released at once when the check cannot retire", async () => {
			const { machine, launch } = await supervisorHeld();
			const supervisor = launch.objects.supervisor;
			await censusEntry(launch, 5151);
			const processes = fakeProcessTable();
			processes.live(5151, "134000000000000005");
			const outcome = repair(launch, machine, { processes });
			await vi.waitFor(() => expect(machine.waits.size).toBe(1));
			machine.releaseHeld(supervisor.path);
			expect(await outcome).toMatchObject({ status: "refused", reason: "census_live", action: "drain_owner" });
			expect(machine.held.size).toBe(0);
			expect(machine.objects.has(supervisor.path)).toBe(true);
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
		});

		it("an inadmissible handle is released at once and the object counts unknown", async () => {
			const { machine, launch } = await supervisorHeld();
			const supervisor = launch.objects.supervisor;
			const processes = fakeProcessTable();
			processes.denied(SUPERVISOR.pid);
			const outcome = repair(launch, machine, { processes });
			await vi.waitFor(() => expect(machine.waits.size).toBe(1));
			const object = machine.objects.get(supervisor.path);
			if (!object) throw new Error("expected the object");
			object.content = Buffer.from("replaced");
			machine.releaseHeld(supervisor.path);
			expect(await outcome).toMatchObject({
				status: "refused",
				reason: "authority_unknown",
				escalation: { reason: "owner_identity_unreadable" },
			});
			expect(machine.held.size).toBe(0);
		});

		it("dismissing the card delivers the cancellation event: the wait ends without releasing anything it did not acquire", async () => {
			const { machine, launch } = await supervisorHeld();
			const supervisor = launch.objects.supervisor;
			const abort = new AbortController();
			const cancel = vi.spyOn(machine.native, "presenceCancelWait");
			const outcome = repair(launch, machine, { signal: abort.signal });
			await vi.waitFor(() => expect(machine.waits.size).toBe(1));
			const [waitId] = machine.waits.keys();
			// The first check released what it acquired (the owner's free object) before the wait was parked.
			expect([...machine.held.values()]).toEqual([supervisor.presenceId]);
			machine.calls.length = 0;
			abort.abort();
			expect(await outcome).toEqual({ status: "cancelled" });
			expect(cancel).toHaveBeenCalledWith(waitId);
			expect([...machine.held.values()]).toEqual([supervisor.presenceId]);
			expect(machine.calls.filter((call) => call.startsWith("presenceReleaseAfterQuiescence"))).toEqual([]);
			expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
		});

		it("an already cancelled repair never starts the wait", async () => {
			const { machine, launch, waits } = await supervisorHeld();
			const abort = new AbortController();
			abort.abort();
			expect(await repair(launch, machine, { signal: abort.signal })).toEqual({ status: "cancelled" });
			expect(waits).toEqual([]);
		});
	});
});
