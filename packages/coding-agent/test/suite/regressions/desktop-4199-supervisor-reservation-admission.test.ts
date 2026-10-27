import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEndpointReservationStore } from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { parseSupervisorArgs } from "../../../src/modes/rpc/host-lifecycle-launch.ts";
import {
	admitClaimedParticipant,
	credentialCommitment,
	grantClaimedParticipant,
	grantVerifiedParticipant,
	IDENTITY_OBSERVATION_ATTEMPTS,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
	readClaimantIdentity,
	reservationStorePath,
	waitForClaim,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { resolvePresenceRoot } from "../../../src/modes/rpc/presence-placement.ts";
import { loadPresencePlacement } from "../../../src/modes/rpc/socket-secret-native.ts";
import { socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { admitReservedHostArgs } from "../../../src/modes/rpc/supervisor-route.ts";

const lockRoot = vi.hoisted(() => ({ dir: "" }));

// The endpoint's fixed reservation store lives beside its ensure lock (design 4.2a step 1), whose win32 name comes from
// the pipe-address formula; on a POSIX runner the lock target is pointed at each test's own directory instead.
vi.mock("../../../src/modes/rpc/host-ensure-lock.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-ensure-lock.ts")>()),
	hostEnsureLockTarget: () => join(lockRoot.dir, "endpoint"),
}));

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Wrapper-safe
// discovery and one-time claim" steps 2 and 4, test 6). Security contract: a supervisor launched with a reservation
// locator claims its role and starts only once granted, after verifying the parent's established secret read-only
// against the granted commitment; it never provisions or repairs, and never falls back to a direct launch. The locator
// is consumed here rather than forwarded as supervisor authority; the host receives its own host-role locator.
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const OWNER = { pid: 100, processStartTime: "133000000000000001" };
const SELF = { pid: 200, processStartTime: "133000000000000002" };
const SECRET = randomBytes(32);
// A commitment is bound to its role and credential path (design 4.2a), never the bare digest of the secret.
const COMMITMENT = credentialCommitment(SECRET, "supervisor", socketSecretPath(ENDPOINT));

function locatorOf(args: readonly string[]) {
	const locator = parseReservationLocatorArgs(args);
	if (locator === undefined) throw new Error("the launch args carry no reservation locator");
	return locator;
}

describe("supervisor admission through a reservation", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function offered() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-supervisor-"));
		roots.push(root);
		lockRoot.dir = root;
		const store = await openEndpointReservationStore(reservationStorePath(ENDPOINT));
		// Off Windows the presence root is typed unavailable; placement has its own suite.
		const native = loadPresencePlacement({ platform: "linux" });
		const reservation = resolvePresenceRoot({ coordinationTarget: store.path, endpointKey: "endpoint", native });
		const { generation, args } = offerSupervisorLaunch(store, ENDPOINT, OWNER, { reservation, native });
		return { store, generation, args, locator: locatorOf(args) };
	}

	it("the host entry routes on the exact locator flags, refuses a partial locator and ignores a mere prefix", async () => {
		const unrelated = ["--reservation-policy", "strict", "--no-extensions"];
		expect(await admitReservedHostArgs([...unrelated])).toEqual({ args: unrelated });
		await expect(admitReservedHostArgs(["--reservation-store", "/x.db"])).rejects.toMatchObject({
			reason: "locator_incomplete",
		});
	});

	it("keeps the locator out of the host child's arguments", async () => {
		const { args, locator } = await offered();
		const launch = parseSupervisorArgs(["--socket", ENDPOINT, ...args, "--no-extensions"]);
		expect(launch?.reservation).toEqual(locator);
		expect(launch?.hostArgs).toEqual(["--no-extensions"]);
	});

	it("starts once granted and the established secret matches the commitment", async () => {
		const { store, generation, locator } = await offered();
		const admitted = admitClaimedParticipant(locator, SELF, SECRET, { deadlineMs: 5_000 });
		const claim = await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
		expect(claim).toEqual({ claimed: true, participant: SELF });
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SELF, COMMITMENT);
		await expect(admitted).resolves.toBeUndefined();
	});

	it("refuses to start when the established secret differs from the granted commitment", async () => {
		const { store, generation, locator } = await offered();
		const admitted = admitClaimedParticipant(locator, SELF, randomBytes(32), { deadlineMs: 5_000 });
		await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SELF, COMMITMENT);
		await expect(admitted).rejects.toMatchObject({ reason: "commitment_mismatch" });
	});

	it("refuses to start with no established secret instead of provisioning one", async () => {
		const { store, generation, locator } = await offered();
		const admitted = admitClaimedParticipant(locator, SELF, undefined, { deadlineMs: 5_000 });
		await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SELF, COMMITMENT);
		await expect(admitted).rejects.toMatchObject({ reason: "commitment_mismatch" });
	});

	it("refuses to start when no grant arrives, and when the generation is cancelled", async () => {
		const first = await offered();
		await expect(admitClaimedParticipant(first.locator, SELF, SECRET, { deadlineMs: 0 })).rejects.toMatchObject({
			reason: "grant_deadline",
		});
		const second = await offered();
		second.store.cancel(second.generation);
		await expect(admitClaimedParticipant(second.locator, SELF, SECRET, { deadlineMs: 5_000 })).rejects.toMatchObject({
			reason: "generation_cancelled",
		});
	});

	it("the issuer grants the claimant whose start time the OS confirms, bound to the secret's commitment", async () => {
		const { store, generation, locator } = await offered();
		const admitted = admitClaimedParticipant(locator, SELF, SECRET, { deadlineMs: 5_000 });
		const observe = async (pid: number) => (pid === SELF.pid ? SELF.processStartTime : undefined);
		await grantClaimedParticipant(store, generation, "supervisor", OWNER, SECRET, observe, { deadlineMs: 5_000 });
		await expect(admitted).resolves.toBeUndefined();
	});

	it("binds the commitment to the role and the credential path, so the bare digest and the other role's digest are refused", async () => {
		const { store, generation, locator } = await offered();
		const bare = createHash("sha256").update(SECRET).digest();
		const host = credentialCommitment(SECRET, "host", socketSecretPath(ENDPOINT));
		expect(COMMITMENT.equals(bare)).toBe(false);
		expect(COMMITMENT.equals(host)).toBe(false);
		expect(credentialCommitment(SECRET, "supervisor", `${socketSecretPath(ENDPOINT)}2`).equals(COMMITMENT)).toBe(
			false,
		);
		const admitted = admitClaimedParticipant(locator, SELF, SECRET, { deadlineMs: 5_000 });
		await waitForClaim(store, generation, "supervisor", { deadlineMs: 5_000 });
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SELF, bare);
		await expect(admitted).rejects.toMatchObject({ reason: "commitment_mismatch" });
	});

	it("the issuer's grant carries the commitment bound to the claimed role and the secret's path", async () => {
		const { store, generation, locator } = await offered();
		const admitted = admitClaimedParticipant(locator, SELF, SECRET, { deadlineMs: 5_000 });
		const observe = async (pid: number) => (pid === SELF.pid ? SELF.processStartTime : undefined);
		await grantClaimedParticipant(store, generation, "supervisor", OWNER, SECRET, observe, { deadlineMs: 5_000 });
		await expect(admitted).resolves.toBeUndefined();
		expect(store.grantedRole(locator, JSON.stringify(SELF))?.commitment).toBe(COMMITMENT.toString("hex"));
	});

	// Design 4.2a: an unreadable identity gets a second observation inside the bound, then stays unknown: no grant.
	it("the issuer observes a claimant again when the first probe fails, bounded, and grants nothing when both fail", async () => {
		const first = await offered();
		void admitClaimedParticipant(first.locator, SELF, SECRET, { deadlineMs: 5_000 }).catch(() => undefined);
		let probes = 0;
		const flaky = async () => {
			probes++;
			if (probes === 1) throw new Error("CIM probe timed out");
			return SELF.processStartTime;
		};
		await grantClaimedParticipant(first.store, first.generation, "supervisor", OWNER, SECRET, flaky, {
			deadlineMs: 5_000,
		});
		expect(probes).toBe(2);
		expect(
			first.store.roleRow({ endpoint: ENDPOINT, generation: first.generation, role: "supervisor" })?.status,
		).toBe("granted");

		const second = await offered();
		void admitClaimedParticipant(second.locator, SELF, SECRET, { deadlineMs: 100 }).catch(() => undefined);
		let starved = 0;
		const unreadable = async () => {
			starved++;
			throw new Error("CIM probe timed out");
		};
		await expect(
			grantClaimedParticipant(second.store, second.generation, "supervisor", OWNER, SECRET, unreadable, {
				deadlineMs: 5_000,
			}),
		).rejects.toMatchObject({ reason: "identity_unverified" });
		expect(starved).toBe(IDENTITY_OBSERVATION_ATTEMPTS);
		expect(
			second.store.roleRow({ endpoint: ENDPOINT, generation: second.generation, role: "supervisor" })?.status,
		).toBe("claimed");
	});

	it("a claimant reads its own identity with the same bound and claims nothing when it stays unreadable", async () => {
		let reads = 0;
		const flaky = async () => {
			reads++;
			if (reads === 1) throw new Error("CIM probe timed out");
			return SELF.processStartTime;
		};
		expect(await readClaimantIdentity(SELF.pid, flaky, 5_000)).toEqual(SELF);
		expect(reads).toBe(2);
		let starved = 0;
		const unreadable = async () => {
			starved++;
			return undefined;
		};
		await expect(readClaimantIdentity(SELF.pid, unreadable, 5_000)).rejects.toMatchObject({
			reason: "identity_unverified",
		});
		expect(starved).toBe(IDENTITY_OBSERVATION_ATTEMPTS);
	});

	it("the issuer refuses a claimant the OS no longer sees with the claimed start time", async () => {
		const { store, generation, locator } = await offered();
		void admitClaimedParticipant(locator, SELF, SECRET, { deadlineMs: 100 }).catch(() => undefined);
		const replaced = async () => "133000000000000099";
		await expect(
			grantClaimedParticipant(store, generation, "supervisor", OWNER, SECRET, replaced, { deadlineMs: 5_000 }),
		).rejects.toMatchObject({ reason: "participant_mismatch" });
		expect(store.roleRow({ endpoint: ENDPOINT, generation, role: "supervisor" })?.status).toBe("claimed");
	});

	it("the issuer gives up, bounded, when nothing claims the role", async () => {
		const { store, generation } = await offered();
		await expect(
			grantClaimedParticipant(store, generation, "supervisor", OWNER, SECRET, async () => undefined, {
				deadlineMs: 0,
			}),
		).rejects.toMatchObject({ reason: "claim_deadline" });
	});
});
