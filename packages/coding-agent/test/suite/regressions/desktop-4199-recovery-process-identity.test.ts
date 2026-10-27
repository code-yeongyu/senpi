import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type EndpointReservationStore,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { recoverEndpointReservations, recoveryProber } from "../../../src/modes/rpc/endpoint-recovery.ts";
import {
	createGenerationDirectory,
	createHostDaemonPaths,
	generationPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { startHost } from "../../../src/modes/rpc/host-ensure-start.ts";
import {
	acquireOwnerPresence,
	claimLaunchRole,
	grantClaimedParticipant,
	grantVerifiedParticipant,
	type LaunchIdentity,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
	reservationStorePath,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { recordChildPid } from "../../../src/modes/rpc/host-lifecycle-scratch.ts";
import { recordLaunchProvenance } from "../../../src/modes/rpc/launch-provenance.ts";
import { createSessionPathReservations, readSessionPathClaims } from "../../../src/modes/rpc/host-reservations.ts";
import { resolvePresenceRoot } from "../../../src/modes/rpc/presence-placement.ts";
import {
	bridgeProcessIdentity,
	classifyObservation,
	ownProcessIdentity,
	processEvidence,
	startTimeEvidence,
} from "../../../src/modes/rpc/process-evidence.ts";
import { createSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { FAKE_KERNEL_SESSION, fakeWindows } from "../../helpers/fake-windows-presence.ts";

const mocked = vi.hoisted(() => ({ lockDir: "", placement: undefined as unknown, spawn: undefined as unknown }));

vi.mock("../../../src/modes/rpc/socket-secret-native.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/socket-secret-native.ts")>()),
	// Every bridge in this file is passed explicitly, or installed as `mocked.placement` for a startHost that loads one;
	// a default load would be the real (absent) one.
	loadPresencePlacement: () => mocked.placement ?? { status: "unavailable", reason: "native_unavailable" },
}));

vi.mock("../../../src/modes/rpc/host-ensure-lock.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-ensure-lock.ts")>()),
	hostEnsureLockTarget: () => join(mocked.lockDir, "endpoint"),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	mocked.spawn = actual.spawn;
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "OS identity" and
// "Process evidence and the kernel-session gate (Revision 8)", clause (ii); Revision 3/4 identity paragraphs). Security
// contract: on Windows, process evidence comes from ONE retained handle, `OpenProcess` + `GetProcessId` + the creation
// FILETIME + the `TokenUser` SID, never from a CIM table. "A readable different creation time proves the recorded
// instance gone even if the replacement is still live under the same SID"; "A matching creation time with unexpected
// SID, access denial, unreadable fields or inconsistent handle/PID is unknown"; "an account mismatch with the same birth
// identity is an unresolved inconsistency, not permission to reclaim". The issuer "requires `GetProcessId`, the exact
// creation `FILETIME` and the token SID to match on that handle, and retains the handle while it grants and observes
// that participant"; "a non-match only refuses the grant, which is always safe".
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const ENDPOINT_KEY = "0123456789abcdef0123456789abcdef";
const TARGET = `C:\\Users\\u\\AppData\\Local\\Temp\\senpi-rpc-host-locks\\${ENDPOINT_KEY}`;
const STORE_DIR = "C:\\Users\\u\\AppData\\Local\\Temp\\senpi-rpc-host-locks";
const SID = "S-1-5-21-1000-2000-3000-1001";
const OTHER_SID = "S-1-5-21-9-9-9-500";
const CREATED = "134000000000000000";
const OWNER: LaunchIdentity = { pid: 100, processStartTime: CREATED, userSid: SID };
const SUPERVISOR: LaunchIdentity = { pid: 4242, processStartTime: "134000000000000001", userSid: SID };
/** A row written before identities carried a SID. */
const LEGACY_OWNER: LaunchIdentity = { pid: 100, processStartTime: CREATED };
const SECRET = Buffer.alloc(32, 7);
const COMMITMENT = createHash("sha256").update(SECRET).digest();

type Machine = ReturnType<typeof fakeWindows>;

describe("#4199 process evidence through the retained handle: PID, creation FILETIME and token SID", () => {
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
		const root = await mkdtemp(join(tmpdir(), "rpc4199-identity-"));
		roots.push(root);
		return root;
	}

	async function openStore(path: string) {
		const store = await openEndpointReservationStore(path);
		stores.push(store);
		return store;
	}

	/** A reserving owner that holds its object, reserved and offered the supervisor role on `machine`. */
	async function offered(machine: Machine, owner: LaunchIdentity = OWNER) {
		const root = await tempRoot();
		// The endpoint's fixed store beside its (mocked) ensure lock: the one store a claimant's locator may name.
		mocked.lockDir = root;
		const store = await openStore(reservationStorePath(ENDPOINT));
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
		return { root, store, generation, locator };
	}

	/**
	 * A launch whose supervisor was granted, after which every process crashed (the kernel closed their lock handles) and
	 * the owner's object vanished: the owner's entry can then be discharged only by the exact process proof (design
	 * test 19), so recovery must observe the recorded owner through the bridge.
	 */
	async function crashedWithoutOwnerObject(machine: Machine, owner: LaunchIdentity = OWNER) {
		const launch = await offered(machine, owner);
		await claimLaunchRole(launch.locator, SUPERVISOR, machine.load);
		grantVerifiedParticipant(launch.store, launch.generation, "supervisor", owner, SUPERVISOR, COMMITMENT);
		machine.held.clear();
		const object = launch.store.reservation(launch.generation).ownerPresence;
		if (object.status !== "predeclared") throw new Error("expected the owner's object");
		machine.objects.delete(object.path);
		const paths = await createHostDaemonPaths({
			agentDir: join(launch.root, "agent"),
			socket: join(launch.root, "rpc.sock"),
		});
		return { ...launch, paths };
	}

	/** Recovery with the machine's bridge as its only process-evidence source: no injected observer. */
	function recover(launch: Awaited<ReturnType<typeof crashedWithoutOwnerObject>>, machine: Machine) {
		return recoverEndpointReservations(
			launch.store,
			ENDPOINT,
			launch.paths,
			recoveryProber(STORE_DIR, machine.load, { daemonDirectory: launch.paths.dir }),
		);
	}

	describe("recovery-time observation (design 4.2a 'OS identity'; clause (iii) admits it on a local store)", () => {
		it("a matching creation FILETIME under a different SID is not the recorded process: owner_identity_inconsistent, never live", async () => {
			// "A matching creation time with unexpected SID ... is unknown"; "an account mismatch with the same birth identity
			// is an unresolved inconsistency, not permission to reclaim."
			const machine = fakeWindows();
			const launch = await crashedWithoutOwnerObject(machine);
			machine.processes.live(OWNER.pid, CREATED, OTHER_SID);
			const outcome = await recover(launch, machine);
			expect(outcome).toMatchObject({
				status: "refused",
				reason: "authority_unknown",
				escalation: { reason: "owner_identity_inconsistent", observations: 2, cached: false },
			});
			expect(launch.store.reservation(launch.generation)).toMatchObject({
				state: "cancelling",
				escalation: { subject: "owner", reason: "owner_identity_inconsistent" },
			});
			// Observed through the bridge, on a handle opened for each observation and closed after it.
			expect(machine.processes.calls.filter((call) => call === `processOpen ${OWNER.pid}`)).toHaveLength(2);
			expect(machine.processes.handles.size).toBe(0);
		});

		it("the same PID, creation FILETIME and SID is the recorded process, and live while its object is unsignalled", async () => {
			// Clause (ii)/(iii): "A match on that handle ... describe[s] that exact instance."
			const machine = fakeWindows();
			const launch = await crashedWithoutOwnerObject(machine);
			machine.processes.live(OWNER.pid, CREATED, SID);
			expect(await recover(launch, machine)).toMatchObject({ status: "refused", reason: "authority_live" });
			expect(launch.store.reservation(launch.generation).escalation).toBeNull();
		});

		it("GetProcessId on the handle differing from the opened PID is an inconsistent observation: owner_identity_inconsistent", async () => {
			// "A matching creation time with unexpected SID, access denial, unreadable fields or inconsistent handle/PID is
			// unknown"; the budget gives it "an initial native observation and at most one fresh reopen/requery".
			const machine = fakeWindows();
			const launch = await crashedWithoutOwnerObject(machine);
			machine.processes.answers(OWNER.pid, { handlePid: 101, creationTime: CREATED, userSid: SID });
			expect(await recover(launch, machine)).toMatchObject({
				status: "refused",
				reason: "authority_unknown",
				escalation: { reason: "owner_identity_inconsistent", observations: 2 },
			});
		});

		it("a different creation FILETIME at the same PID is gone even while the replacement lives under the same SID", async () => {
			// "a readable different creation time proves the recorded instance gone even if the replacement is still live
			// under the same SID. Reject its stale claim/grant and never signal or adopt the replacement."
			const machine = fakeWindows();
			const launch = await crashedWithoutOwnerObject(machine);
			machine.processes.live(OWNER.pid, "134000000010000000", SID);
			expect(await recover(launch, machine)).toEqual({ status: "recovered", generations: [launch.generation] });
			expect(launch.store.reservation(launch.generation).retirement?.discharges.owner).toBe("process_gone");
		});

		it("a signalled process object with the recorded identity is gone", async () => {
			// Clause (ii): "the handle's signalled state when the process exits ... describe[s] that exact instance."
			const machine = fakeWindows();
			const launch = await crashedWithoutOwnerObject(machine);
			machine.processes.exited(OWNER.pid, CREATED, SID);
			expect(await recover(launch, machine)).toEqual({ status: "recovered", generations: [launch.generation] });
			expect(launch.store.reservation(launch.generation).retirement?.discharges.owner).toBe("process_gone");
		});

		it("an absent PID is gone", async () => {
			// Observation table: `OpenProcess` reporting no such process is `gone` (PID absent).
			const machine = fakeWindows();
			const launch = await crashedWithoutOwnerObject(machine);
			expect(await recover(launch, machine)).toEqual({ status: "recovered", generations: [launch.generation] });
		});

		it("a denied open and every unreadable field stay unknown: owner_identity_unreadable after the one requery", async () => {
			// "access denial, unreadable fields ... is unknown"; "If the identity is still unreadable ... persist an escalated
			// reason ... `owner_identity_unreadable`".
			const unreadable = [
				(machine: Machine) => machine.processes.denied(OWNER.pid),
				(machine: Machine) => machine.processes.answers(OWNER.pid, { creationTime: null, userSid: SID }),
				(machine: Machine) => machine.processes.answers(OWNER.pid, { creationTime: CREATED, userSid: null }),
				(machine: Machine) =>
					machine.processes.answers(OWNER.pid, { creationTime: CREATED, userSid: SID, exited: null }),
			];
			for (const install of unreadable) {
				const machine = fakeWindows();
				const launch = await crashedWithoutOwnerObject(machine);
				install(machine);
				expect(await recover(launch, machine)).toMatchObject({
					status: "refused",
					reason: "authority_unknown",
					escalation: { reason: "owner_identity_unreadable", observations: 2 },
				});
				expect(launch.store.reservation(launch.generation).state).toBe("cancelling");
			}
		});

		it("a recorded identity without a SID cannot be confirmed live through the handle: owner_identity_incomplete at once", async () => {
			// The record is "PID + full creation FILETIME + TokenUser SID read on ONE handle"; an identity "that cannot be
			// compared" is `owner_identity_incomplete`. A SID-less row was read by the start-time reader (the CIM table, which
			// truncates the FILETIME to microseconds), so its creation time is never compared against a handle's: a different
			// one is not a "verified common observation domain" mismatch and does not prove the row gone either.
			const machine = fakeWindows();
			const launch = await crashedWithoutOwnerObject(machine, LEGACY_OWNER);
			machine.processes.live(OWNER.pid, CREATED, SID);
			expect(await recover(launch, machine)).toMatchObject({
				status: "refused",
				reason: "authority_unknown",
				escalation: { reason: "owner_identity_incomplete", observations: 1 },
			});
			const replaced = fakeWindows();
			const second = await crashedWithoutOwnerObject(replaced, LEGACY_OWNER);
			replaced.processes.live(OWNER.pid, "134000000010000000", SID);
			expect(await recover(second, replaced)).toMatchObject({
				status: "refused",
				reason: "authority_unknown",
				escalation: { reason: "owner_identity_incomplete", observations: 1 },
			});
		});

		it("a proven prior boot resolves an entry every observation found unreadable, never one found inconsistent", async () => {
			// senpi#4481 fold meets the handle adapter: the reboot proof answers only after the observation could not decide
			// the entry. A denied open (unreadable, twice) is such an entry; a process answering the recorded birth under
			// another SID is "an unresolved inconsistency, not permission to reclaim", whatever the boot evidence says.
			const S2 = "133200000000000000";
			const ROW_PID = 9001;
			async function rebooted(install: (machine: Machine) => void) {
				const machine = fakeWindows();
				const launch = await offered(machine);
				await claimLaunchRole(launch.locator, SUPERVISOR, machine.load);
				grantVerifiedParticipant(launch.store, launch.generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT);
				// Every process of session S1 crashed, its objects left acquirable; a row of that boot sits in the census.
				machine.held.clear();
				const paths = await createHostDaemonPaths({
					agentDir: join(launch.root, "agent"),
					socket: join(launch.root, "rpc.sock"),
				});
				const generation = generationPaths(paths, "gen-s1");
				await createGenerationDirectory(generation);
				await recordLaunchProvenance(generation.launchProvenanceFile, {
					generation: launch.generation,
					kernelSession: { status: "verified", value: FAKE_KERNEL_SESSION },
					directoryLocal: true,
				});
				await writeFile(
					generation.pidFile,
					JSON.stringify({ pid: ROW_PID, processStartTime: CREATED, userSid: SID }),
				);
				install(machine);
				// The confirmed next boot, S2.
				machine.control.kernelSession = { status: "verified", creationTime: S2, reason: null };
				return recover({ ...launch, paths }, machine);
			}
			expect(await rebooted((machine) => machine.processes.denied(ROW_PID))).toMatchObject({
				status: "recovered",
			});
			expect(await rebooted((machine) => machine.processes.live(ROW_PID, CREATED, OTHER_SID))).toMatchObject({
				status: "refused",
				reason: "census_unknown",
				escalation: { reason: "owner_identity_inconsistent", observations: 2 },
			});
		});

		it("the observation table never compares across domains: a SID marks a handle-domain record", () => {
			// "Verified common boot/PID/clock domain and units ... different exact creation/start discriminator" is gone; a
			// record and an observation from different readers are "noncomparable", unknown. A record carries `userSid` only
			// when it was read on a process handle; the start-time reader's identity carries none.
			const opened = (creationTime: string) => ({
				kind: "opened" as const,
				facts: { handlePid: 100, creationTime, userSid: SID, exited: false },
			});
			expect(classifyObservation(LEGACY_OWNER, opened("134000000010000000"))).toMatchObject({
				kind: "unknown",
				reason: "incomplete",
			});
			expect(classifyObservation(LEGACY_OWNER, opened(CREATED))).toMatchObject({
				kind: "unknown",
				reason: "incomplete",
			});
			expect(classifyObservation(OWNER, { kind: "present", identity: "134000000010000000" })).toMatchObject({
				kind: "unknown",
				reason: "incomplete",
			});
			expect(classifyObservation(OWNER, { kind: "present", identity: CREATED })).toMatchObject({
				kind: "unknown",
				reason: "incomplete",
			});
			// Same domain, each way: exact.
			expect(classifyObservation(OWNER, opened("134000000010000000"))).toEqual({
				kind: "gone",
				reason: "birth_mismatch",
			});
			expect(classifyObservation(OWNER, opened(CREATED))).toEqual({ kind: "live" });
			expect(classifyObservation(LEGACY_OWNER, { kind: "present", identity: "134000000010000000" })).toEqual({
				kind: "gone",
				reason: "birth_mismatch",
			});
			expect(classifyObservation(LEGACY_OWNER, { kind: "present", identity: CREATED })).toEqual({ kind: "live" });
		});
	});

	describe("the daemon's own records carry the handle-domain identity (design 4.2a 'OS identity', the census)", () => {
		const CHILD_PID = 7001;
		const CHILD_CREATED = "134000000000000007";

		/**
		 * An abandoned generation whose owner is gone, so only the daemon's own records can keep it from retiring. Its rows
		 * carry the launch provenance startHost records beside them (senpi#4479 fold): the reserving owner's kernel session,
		 * on the local daemon directory, so the census observes them through the gate (clauses i, iii).
		 */
		async function abandoned(machine: Machine) {
			const launch = await crashedWithoutOwnerObject(machine);
			const generation = generationPaths(launch.paths, "gen-a");
			await createGenerationDirectory(generation);
			await recordLaunchProvenance(generation.launchProvenanceFile, {
				generation: launch.generation,
				kernelSession: { status: "verified", value: FAKE_KERNEL_SESSION },
				directoryLocal: true,
			});
			return { ...launch, generationDir: generation };
		}

		it("host-child.pid recorded through the bridge carries the child's creation FILETIME and SID, and its live entry answers drain_owner", async () => {
			// Before: the supervisor recorded its child from the CIM table, SID-less, so a live child read
			// `owner_identity_incomplete` and routed to Repair instead of `drain_owner`.
			const machine = fakeWindows();
			const launch = await abandoned(machine);
			machine.processes.live(CHILD_PID, CHILD_CREATED, SID);
			const identity = (pid: number) => bridgeProcessIdentity(machine.load, pid);
			await recordChildPid(launch.generationDir.childPidFile, CHILD_PID, () => true, identity);
			expect(JSON.parse(await readFile(launch.generationDir.childPidFile, "utf8"))).toEqual({
				pid: CHILD_PID,
				processStartTime: CHILD_CREATED,
				userSid: SID,
			});
			expect(machine.processes.handles.size).toBe(0);
			expect(await recover(launch, machine)).toMatchObject({
				status: "refused",
				reason: "census_live",
				action: "drain_owner",
				detail: expect.stringContaining(`host child (pid ${CHILD_PID}) is live`),
			});
			expect(launch.store.reservation(launch.generation).escalation).toBeNull();
		});

		it("an identity read after the child exited is never recorded, through the bridge as before", async () => {
			const machine = fakeWindows();
			const launch = await abandoned(machine);
			machine.processes.live(CHILD_PID, CHILD_CREATED, SID);
			const identity = (pid: number) => bridgeProcessIdentity(machine.load, pid);
			await recordChildPid(launch.generationDir.childPidFile, CHILD_PID, () => false, identity);
			expect(JSON.parse(await readFile(launch.generationDir.childPidFile, "utf8"))).toEqual({
				pid: CHILD_PID,
				processStartTime: null,
			});
		});

		it("a session claim published with the host's own handle identity carries its SID, reads back with it, and its live owner answers drain_owner", async () => {
			const machine = fakeWindows();
			const launch = await abandoned(machine);
			machine.processes.live(process.pid, "134000000000000008", SID);
			const reservations = createSessionPathReservations({
				daemonDir: launch.paths.dir,
				instanceId: "gen-a",
				identity: () => ownProcessIdentity(machine.load),
			});
			expect(await reservations.claim(join(launch.root, "sessions", "a.jsonl"))).toBeUndefined();
			const claims = await readSessionPathClaims(launch.paths.reservationsDir);
			expect(claims.map(({ owner }) => owner)).toEqual([
				expect.objectContaining({
					instanceId: "gen-a",
					pid: process.pid,
					processStartTime: "134000000000000008",
					userSid: SID,
				}),
			]);
			expect(await recover(launch, machine)).toMatchObject({
				status: "refused",
				reason: "census_live",
				action: "drain_owner",
				detail: expect.stringContaining(`session claim of generation gen-a (pid ${process.pid}) is live`),
			});
		});

		it("host.pid: startHost registers the granted supervisor's handle identity (creation FILETIME and SID), not the CIM probe's", async () => {
			// The reserving owner verified its supervisor on a retained handle; the generation record names that process by
			// the same three facts, so a later recovery census reads it in the handle domain.
			const machine = fakeWindows();
			const root = await tempRoot();
			mocked.lockDir = root;
			mocked.placement = machine.load;
			const socket = join(root, "rpc.sock");
			const agentDir = join(root, "agent");
			await createSocketSecret(socketSecretPath(socket));
			const paths = await createHostDaemonPaths({ agentDir, socket });
			const storePath = `${join(root, "endpoint")}.reservation.db`;
			const HANDLE_CREATED = "134000000000000019";
			/** What the CIM table says for the same instant: microsecond precision, the last digit lost. */
			const CIM_CREATED = "134000000000000010";
			let sleeper: childProcess.ChildProcess | undefined;
			let recorded: unknown;
			let claimed: Promise<unknown> | undefined;
			vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
			let outcome: unknown;
			try {
				const actualSpawn = mocked.spawn as typeof childProcess.spawn;
				await vi.mocked(childProcess.spawn).withImplementation(
					() => {
						// The supervisor process: a live child this test owns, under the spawned PID the issuer verifies.
						sleeper = actualSpawn(process.execPath, ["-e", "setInterval(() => {}, 1_000_000)"], {
							stdio: "ignore",
						});
						return sleeper;
					},
					async () => {
						outcome = await startHost(paths, socket, {
							agentDir,
							socket,
							_test: {
								readinessTimeoutMs: 100,
								stopTimeoutMs: 1_000,
								readProcessStartTime: async (pid) => {
									// The route is settled: the rest of the start runs on this host's own platform.
									vi.unstubAllGlobals();
									if (claimed === undefined) {
										machine.processes.live(pid, HANDLE_CREATED, SID);
										const store = await openStore(storePath);
										const [generation] = store.activeGenerations(socket);
										if (generation === undefined) throw new Error("no reserved generation");
										// The supervisor claims with its own handle identity, as `admitReservedLaunch` does.
										claimed = claimLaunchRole(
											{ storePath, endpoint: socket, generation, role: "supervisor" },
											{ pid, processStartTime: HANDLE_CREATED, userSid: SID },
											machine.load,
										);
									}
									return CIM_CREATED;
								},
								beforeReadinessTeardown: async () => {
									const pointer = JSON.parse(await readFile(paths.pointerFile, "utf8")) as {
										instance_id: string;
									};
									recorded = JSON.parse(
										await readFile(generationPaths(paths, pointer.instance_id).pidFile, "utf8"),
									);
								},
							},
						}).catch((error: unknown) => error);
					},
				);
			} finally {
				vi.unstubAllGlobals();
				await claimed?.catch(() => undefined);
				if (sleeper && sleeper.exitCode === null && sleeper.signalCode === null) {
					const exited = new Promise<void>((resolve) => sleeper?.once("exit", () => resolve()));
					sleeper.kill("SIGKILL");
					await exited;
				}
			}
			// No host answered on the socket, so the start failed after its registration; the record it wrote is the evidence.
			expect(outcome).toBeInstanceOf(Error);
			expect(recorded).toMatchObject({
				pid: sleeper?.pid,
				processStartTime: HANDLE_CREATED,
				userSid: SID,
				socket,
			});
			// The issuer's handle on the supervisor ends with its readiness verdict.
			expect(machine.processes.handles.size).toBe(0);
		});
	});

	describe("grant-time verification of a live claimant (design 4.2a clause (ii), not gated)", () => {
		const SELF: LaunchIdentity = { pid: 200, processStartTime: "134000000000000002", userSid: SID };

		async function claimed(machine: Machine) {
			const launch = await offered(machine);
			await claimLaunchRole(launch.locator, SELF, machine.load);
			expect(launch.store.roleRow(launch.locator)).toMatchObject({
				status: "claimed",
				participant: JSON.stringify(SELF),
			});
			return launch;
		}

		function grant(launch: Awaited<ReturnType<typeof offered>>, machine: Machine) {
			return grantClaimedParticipant(
				launch.store,
				launch.generation,
				"supervisor",
				OWNER,
				SECRET,
				processEvidence(machine.load),
				{ deadlineMs: 5_000 },
			);
		}

		it("refuses a claimant whose token SID differs from the claimed one, with the matching FILETIME, and closes the handle", async () => {
			// "requires `GetProcessId`, the exact creation `FILETIME` and the token SID to match on that handle"; "a non-match
			// only refuses the grant, which is always safe".
			const machine = fakeWindows();
			const launch = await claimed(machine);
			machine.processes.live(SELF.pid, SELF.processStartTime ?? "", OTHER_SID);
			await expect(grant(launch, machine)).rejects.toMatchObject({ reason: "identity_inconsistent" });
			expect(launch.store.roleRow(launch.locator)?.status).toBe("claimed");
			expect(machine.processes.handles.size).toBe(0);
		});

		it("grants the claimant whose PID, creation FILETIME and SID match on one handle, and retains that handle until released", async () => {
			// "retains the handle while it grants and observes that participant".
			const machine = fakeWindows();
			const launch = await claimed(machine);
			machine.processes.live(SELF.pid, SELF.processStartTime ?? "", SID);
			const granted = await grant(launch, machine);
			expect(granted.identity).toEqual(SELF);
			expect(launch.store.roleRow(launch.locator)).toMatchObject({
				status: "granted",
				participant: JSON.stringify(SELF),
			});
			expect(machine.processes.handles.size).toBe(1);
			expect(machine.processes.calls.filter((call) => call === `processOpen ${SELF.pid}`)).toHaveLength(1);
			granted.release();
			expect(machine.processes.handles.size).toBe(0);
		});

		it("refuses a claimant whose PID now names another creation time, a signalled one, and an inconsistent handle", async () => {
			// "Reject its stale claim/grant and never signal or adopt the replacement"; "inconsistent handle/PID is unknown".
			const cases = [
				{
					install: (m: Machine) => m.processes.live(SELF.pid, "134000000000000099", SID),
					reason: "participant_mismatch",
				},
				{
					install: (m: Machine) => m.processes.exited(SELF.pid, SELF.processStartTime ?? "", SID),
					reason: "participant_mismatch",
				},
				{ install: (_m: Machine) => {}, reason: "participant_mismatch" },
				{
					install: (m: Machine) =>
						m.processes.answers(SELF.pid, { handlePid: 201, creationTime: SELF.processStartTime, userSid: SID }),
					reason: "identity_inconsistent",
				},
			] as const;
			for (const { install, reason } of cases) {
				const machine = fakeWindows();
				const launch = await claimed(machine);
				install(machine);
				await expect(grant(launch, machine)).rejects.toMatchObject({ reason });
				expect(launch.store.roleRow(launch.locator)?.status).toBe("claimed");
				expect(machine.processes.handles.size).toBe(0);
			}
		});

		it("an unreadable claimant grants nothing: identity_unverified, and the handle is not kept", async () => {
			// "An observation without an exact start discriminator grants nothing"; "access denial, unreadable fields ... is
			// unknown".
			const cases = [
				(m: Machine) => m.processes.denied(SELF.pid),
				(m: Machine) => m.processes.answers(SELF.pid, { creationTime: SELF.processStartTime, userSid: null }),
				(m: Machine) => m.processes.answers(SELF.pid, { creationTime: null, userSid: SID }),
			];
			for (const install of cases) {
				const machine = fakeWindows();
				const launch = await claimed(machine);
				install(machine);
				await expect(grant(launch, machine)).rejects.toMatchObject({ reason: "identity_unverified" });
				expect(machine.processes.handles.size).toBe(0);
			}
		});

		it("the issuer learns the participant's exit from its process object, never from a ChildProcess event", async () => {
			// "use process-object signalling for exit (`RegisterWaitForSingleObject` or equivalent), not wrapper exit": the wait
			// is on the retained handle, resolves with the object's exit code once it is signalled, and is cancellable; the
			// release of the handle ends it too.
			const machine = fakeWindows();
			const launch = await claimed(machine);
			machine.processes.live(SELF.pid, SELF.processStartTime ?? "", SID);
			const granted = await grant(launch, machine);
			const waiting = granted.waitExit();
			expect(machine.processes.exitWaits.size).toBe(1);
			machine.processes.signal(SELF.pid, 3221225477);
			expect(await waiting).toEqual({ kind: "exited", exitCode: 3221225477 });
			// The handle is still the issuer's until it releases it; a wait on an exited object answers at once.
			expect(machine.processes.handles.size).toBe(1);
			expect(await granted.waitExit()).toEqual({ kind: "exited", exitCode: 3221225477 });
			granted.release();
			expect(machine.processes.handles.size).toBe(0);

			const aborted = fakeWindows();
			const second = await claimed(aborted);
			aborted.processes.live(SELF.pid, SELF.processStartTime ?? "", SID);
			const participant = await grant(second, aborted);
			const controller = new AbortController();
			const cancellable = participant.waitExit(controller.signal);
			controller.abort();
			expect(await cancellable).toEqual({ kind: "cancelled" });
			expect(aborted.processes.exitWaits.size).toBe(0);
			const untilRelease = participant.waitExit();
			participant.release();
			expect(await untilRelease).toEqual({ kind: "cancelled" });
			expect(aborted.processes.calls.filter((call) => call.startsWith("processWaitExit"))).toHaveLength(2);
		});

		it("a claimant records its own PID, creation FILETIME and SID read on one handle of itself, then closes it", async () => {
			// "Verify each actual Windows target using `OpenProcess(...)`, `GetProcessId`, `GetProcessTimes` creation `FILETIME`,
			// and ... `GetTokenInformation(TokenUser)` on that same process handle."
			const machine = fakeWindows();
			machine.processes.live(process.pid, "134000000000000003", SID);
			expect(await ownProcessIdentity(machine.load)).toEqual({
				pid: process.pid,
				processStartTime: "134000000000000003",
				userSid: SID,
			});
			expect(machine.processes.handles.size).toBe(0);
		});

		it("off Windows the issuer still verifies by PID and exact start time, and identities carry no SID", async () => {
			// The design's Windows contracts name Windows targets; the POSIX contract is conditional and out of #4199, so a
			// non-Windows issuer keeps its start-time comparison and its identity encoding.
			const machine = fakeWindows();
			const launch = await offered(machine);
			const posixSelf: LaunchIdentity = { pid: 200, processStartTime: "134000000000000002" };
			await claimLaunchRole(launch.locator, posixSelf, machine.load);
			const granted = await grantClaimedParticipant(
				launch.store,
				launch.generation,
				"supervisor",
				OWNER,
				SECRET,
				startTimeEvidence(async (pid) =>
					pid === posixSelf.pid ? (posixSelf.processStartTime ?? undefined) : undefined,
				),
				{ deadlineMs: 5_000 },
			);
			expect(granted.identity).toEqual(posixSelf);
			expect(launch.store.roleRow(launch.locator)).toMatchObject({
				status: "granted",
				participant: JSON.stringify({ pid: 200, processStartTime: "134000000000000002" }),
			});
			// No handle is retained off the bridge: the ChildProcess exit event stays the supervisor's only signal there.
			expect(await granted.waitExit()).toMatchObject({ kind: "unavailable" });
			granted.release();
		});
	});
});
