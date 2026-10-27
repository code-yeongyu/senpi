import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type EndpointReservationStore,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { recoverEndpointReservations, recoveryProber } from "../../../src/modes/rpc/endpoint-recovery.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import {
	acquireOwnerPresence,
	claimLaunchRole,
	grantClaimedParticipant,
	grantVerifiedParticipant,
	type LaunchIdentity,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { resolvePresenceRoot } from "../../../src/modes/rpc/presence-placement.ts";
import { ownProcessIdentity, processEvidence, startTimeEvidence } from "../../../src/modes/rpc/process-evidence.ts";
import { fakeWindows } from "../../helpers/fake-windows-presence.ts";

vi.mock("../../../src/modes/rpc/socket-secret-native.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/socket-secret-native.ts")>()),
	// Every bridge in this file is passed explicitly; a default load would be the real (absent) one.
	loadPresencePlacement: () => ({ status: "unavailable", reason: "native_unavailable" }),
}));

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
		const store = await openStore(join(root, "endpoint.reservation.db"));
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
		return recoverEndpointReservations(launch.store, ENDPOINT, launch.paths, recoveryProber(STORE_DIR, machine.load));
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
			// compared" is `owner_identity_incomplete`. A different creation time still proves it gone.
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
			expect(await recover(second, replaced)).toEqual({ status: "recovered", generations: [second.generation] });
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
			granted.release();
		});
	});
});
