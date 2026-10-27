import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EndpointReservationStore,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import {
	claimLaunchRole,
	commitListenIntent,
	credentialCommitment,
	grantVerifiedParticipant,
	LaunchReservationError,
	offerSupervisorLaunch,
	parseReservationLocatorArgs,
	reservationStorePath,
	waitForClaim,
	waitForGrant,
} from "../../../src/modes/rpc/host-launch-reservation.ts";
import { socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";

const lockRoot = vi.hoisted(() => ({ dir: "" }));

// The endpoint's fixed reservation store lives beside its ensure lock (design 4.2a step 1), whose win32 name comes from
// the pipe-address formula; on a POSIX runner the lock target is pointed at each test's own directory instead.
vi.mock("../../../src/modes/rpc/host-ensure-lock.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-ensure-lock.ts")>()),
	hostEnsureLockTarget: () => join(lockRoot.dir, "endpoint"),
}));

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Wrapper-safe
// discovery and one-time claim", tests 6 and 10 at the supervisor hop). Security contract: the launcher forwards only a
// non-secret locator; the actual supervisor claims its role from the store with its own identity; the issuer grants only
// when the claimed identity equals what it observed through the OS, bound to the credential commitment; a claimant is
// never granted by waiting, cancellation or a copied locator.
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const OWNER = { pid: 100, processStartTime: "133000000000000001" };
const SUPERVISOR = { pid: 200, processStartTime: "133000000000000002" };
const COMMITMENT = createHash("sha256").update(randomBytes(32)).digest();

function locatorOf(args: readonly string[]) {
	const locator = parseReservationLocatorArgs(args);
	if (locator === undefined) throw new Error("the launch args carry no reservation locator");
	return locator;
}

describe("supervisor launch reservation", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function launched() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-launch-"));
		roots.push(root);
		lockRoot.dir = root;
		const storePath = reservationStorePath(ENDPOINT);
		const store = await openEndpointReservationStore(storePath);
		const offer = offerSupervisorLaunch(store, ENDPOINT, OWNER);
		return { root, storePath, store, ...offer };
	}

	it("forwards only a non-secret locator that names the store, endpoint, generation and role", async () => {
		const { storePath, args, generation } = await launched();
		const locator = locatorOf(args);
		expect(locator).toEqual({ storePath, endpoint: ENDPOINT, generation, role: "supervisor" });
		const nonce = (await openEndpointReservationStore(storePath)).readOffer(locator);
		expect(args.join(" ")).not.toContain(nonce.toString("hex"));
	});

	it("grants the claimant whose identity the issuer observed, bound to the commitment", async () => {
		const { store, args, generation } = await launched();
		const locator = locatorOf(args);
		expect(await claimLaunchRole(locator, SUPERVISOR)).toBe("claimed");
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT);
		expect(await waitForGrant(locator, SUPERVISOR, { deadlineMs: 1_000 })).toEqual({
			granted: true,
			commitment: COMMITMENT.toString("hex"),
		});
	});

	it("refuses to grant when the observed process is not the claimant", async () => {
		const { store, args, generation } = await launched();
		await claimLaunchRole(locatorOf(args), SUPERVISOR);
		const replacement = { pid: SUPERVISOR.pid, processStartTime: "133000000000000099" };
		expect(() => grantVerifiedParticipant(store, generation, "supervisor", OWNER, replacement, COMMITMENT)).toThrow(
			LaunchReservationError,
		);
		expect(store.roleRow({ endpoint: ENDPOINT, generation, role: "supervisor" })?.status).toBe("claimed");
	});

	it.each(["claim", "grant"] as const)(
		"keeps waiting for a %s after an exclusive writer blocks a read",
		async (kind) => {
			const { storePath, store, args, generation } = await launched();
			const locator = locatorOf(args);
			if (kind === "grant") await claimLaunchRole(locator, SUPERVISOR);
			const writer = new DatabaseSync(storePath);
			const blocked = Promise.withResolvers<void>();
			const reservation = EndpointReservationStore.prototype.reservation;
			const read = vi.spyOn(EndpointReservationStore.prototype, "reservation").mockImplementationOnce(function (
				this: EndpointReservationStore,
				id,
			) {
				writer.exec("BEGIN EXCLUSIVE; UPDATE reservations SET revision = revision + 1;");
				try {
					return reservation.call(this, id);
				} finally {
					blocked.resolve();
				}
			});
			const release = (async () => {
				await blocked.promise;
				writer.exec("ROLLBACK;");
				if (kind === "grant") {
					grantVerifiedParticipant(store, generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT);
				} else {
					store.claim(locator, store.readOffer(locator), JSON.stringify(SUPERVISOR));
				}
			})();
			try {
				const result =
					kind === "grant"
						? waitForGrant(locator, SUPERVISOR, { deadlineMs: 2_000 })
						: waitForClaim(store, generation, "supervisor", { deadlineMs: 2_000 });
				await Promise.all([
					expect(result).resolves.toEqual(
						kind === "grant"
							? { granted: true, commitment: COMMITMENT.toString("hex") }
							: { claimed: true, participant: SUPERVISOR },
					),
					release,
				]);
			} finally {
				read.mockRestore();
				writer.close();
				store.close();
			}
		},
	);

	it("refuses to grant from an observed identity with no exact start time", async () => {
		const { store, args, generation } = await launched();
		await claimLaunchRole(locatorOf(args), SUPERVISOR);
		const unreadable = { pid: SUPERVISOR.pid, processStartTime: null };
		expect(() => grantVerifiedParticipant(store, generation, "supervisor", OWNER, unreadable, COMMITMENT)).toThrow(
			expect.objectContaining({ reason: "identity_unverified" }),
		);
	});

	it("a claimant whose generation is cancelled learns it is not granted", async () => {
		const { store, args, generation } = await launched();
		const locator = locatorOf(args);
		await claimLaunchRole(locator, SUPERVISOR);
		store.cancel(generation);
		expect(await waitForGrant(locator, SUPERVISOR, { deadlineMs: 1_000 })).toEqual({
			granted: false,
			reason: "generation_cancelled",
		});
	});

	it("a claimant that is never granted gets a bounded refusal, never an inferred grant", async () => {
		const { args } = await launched();
		const locator = locatorOf(args);
		await claimLaunchRole(locator, SUPERVISOR);
		expect(await waitForGrant(locator, SUPERVISOR, { deadlineMs: 0 })).toEqual({
			granted: false,
			reason: "grant_deadline",
		});
	});

	it("a copied locator in another process's hands cannot claim the role already claimed", async () => {
		const { args } = await launched();
		const locator = locatorOf(args);
		await claimLaunchRole(locator, SUPERVISOR);
		const intruder = { pid: 300, processStartTime: "133000000000000003" };
		await expect(claimLaunchRole(locator, intruder)).rejects.toMatchObject({ reason: "role_not_offered" });
	});

	// Design 4.2a step 1: the locator must resolve to the endpoint's fixed store, never a file a wrapper names.
	it("refuses a locator whose store is not the endpoint's fixed reservation store, consuming nothing", async () => {
		const { root, store, args, generation } = await launched();
		const locator = locatorOf(args);
		const elsewhere = await openEndpointReservationStore(join(root, "elsewhere.db"));
		elsewhere.close();
		const renamed = { ...locator, storePath: join(root, "elsewhere.db") };
		await expect(claimLaunchRole(renamed, SUPERVISOR)).rejects.toMatchObject({ reason: "store_mismatch" });
		await expect(waitForGrant(renamed, SUPERVISOR, { deadlineMs: 0 })).rejects.toMatchObject({
			reason: "store_mismatch",
		});
		await expect(commitListenIntent(renamed, SUPERVISOR, randomBytes(32))).rejects.toMatchObject({
			reason: "store_mismatch",
		});
		expect(store.roleRow({ endpoint: ENDPOINT, generation, role: "supervisor" })?.status).toBe("offered");
	});

	// Design 4.2a step 4: the granted participant commits its pre-listen intent in a transaction that revalidates the
	// grant, so a cancellation recorded after the grant is seen before the bind.
	it("a granted claimant commits its pre-listen intent, and not once the generation was cancelled", async () => {
		const { store, args, generation } = await launched();
		const locator = locatorOf(args);
		const secret = randomBytes(32);
		await claimLaunchRole(locator, SUPERVISOR);
		const commitment = credentialCommitment(secret, "supervisor", socketSecretPath(ENDPOINT));
		grantVerifiedParticipant(store, generation, "supervisor", OWNER, SUPERVISOR, commitment);
		await expect(commitListenIntent(locator, SUPERVISOR, randomBytes(32))).rejects.toMatchObject({
			reason: "commitment_mismatch",
		});
		await expect(commitListenIntent(locator, SUPERVISOR, secret)).resolves.toBeUndefined();
		expect(store.roleRow({ endpoint: ENDPOINT, generation, role: "supervisor" })?.listenIntent).toBe(true);
		store.cancel(generation);
		await expect(commitListenIntent(locator, SUPERVISOR, secret)).rejects.toMatchObject({
			reason: "generation_cancelled",
		});
	});

	it("an argv with no locator is a direct launch, and a partial locator is refused", () => {
		expect(parseReservationLocatorArgs(["--socket", ENDPOINT])).toBeUndefined();
		expect(() => parseReservationLocatorArgs(["--reservation-store", "/x.db"])).toThrow(LaunchReservationError);
	});

	it("the issuer learns the claimed identity, bounded, and verifies that process rather than the one it spawned", async () => {
		const { store, args, generation } = await launched();
		const locator = locatorOf(args);
		expect(await waitForClaim(store, generation, "supervisor", { deadlineMs: 0 })).toEqual({
			claimed: false,
			reason: "claim_deadline",
		});
		await claimLaunchRole(locator, SUPERVISOR);
		expect(await waitForClaim(store, generation, "supervisor", { deadlineMs: 1_000 })).toEqual({
			claimed: true,
			participant: SUPERVISOR,
		});
	});

	it("an issuer waiting on a cancelled generation learns no role was claimed", async () => {
		const { store, generation } = await launched();
		store.cancel(generation);
		expect(await waitForClaim(store, generation, "supervisor", { deadlineMs: 1_000 })).toEqual({
			claimed: false,
			reason: "generation_cancelled",
		});
	});
});
