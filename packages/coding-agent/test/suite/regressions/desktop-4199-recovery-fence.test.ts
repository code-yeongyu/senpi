import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EndpointReservationError,
	type EndpointReservationStore,
	openEndpointReservationStore,
	type PresenceObjectRecord,
	type ReservationPresence,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Crash, cancellation
// and commit", "Recovery transaction order" steps 2, 4 and 5; tests 11 and 22). Storage contract: recovery fences an
// abandoned generation durably, retires it only against the revision it fenced and only with a discharge for every
// recorded authority entry (the reserving owner until its `released`, every granted role without `released`), and the
// retired record stays a tombstone that no late claim, replayed nonce or stale grant revives. Exactly one successor: no
// generation is reserved for an endpoint while an earlier one is not retired.
const OWNER = '{"pid":100,"processStartTime":"134000000000000000"}';
const SUPERVISOR = '{"pid":4242,"processStartTime":"134000000000000001"}';
const HOST = '{"pid":4343,"processStartTime":"134000000000000002"}';
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const COMMITMENT = createHash("sha256").update(randomBytes(32)).digest();
const NO_PRESENCE: ReservationPresence = {
	root: { status: "presence_unavailable", reason: "unsupported_platform", detail: null },
	ownerKernelSession: { status: "unverified", reason: "unsupported_platform" },
};
const NO_OBJECT: PresenceObjectRecord = { status: "presence_unavailable" };

function rejection(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof EndpointReservationError) return error.reason;
		throw error;
	}
	return "accepted";
}

describe("#4199 recovery fence and retirement tombstone", () => {
	const roots: string[] = [];
	const stores: EndpointReservationStore[] = [];

	afterEach(async () => {
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function open() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-fence-"));
		roots.push(root);
		const store = await openEndpointReservationStore(join(root, "endpoint.reservation.db"));
		stores.push(store);
		return store;
	}

	/** A generation whose supervisor was claimed (and optionally granted), as a crashed launch leaves it. */
	async function crashed(grantSupervisor: boolean) {
		const store = await open();
		const generation = store.reserve(ENDPOINT, OWNER, ["supervisor", "host"], NO_PRESENCE, NO_OBJECT);
		store.offer(generation, "supervisor", OWNER, NO_OBJECT);
		const locator = { endpoint: ENDPOINT, generation, role: "supervisor" as const };
		const nonce = store.readOffer(locator);
		store.claim(locator, nonce, SUPERVISOR);
		if (grantSupervisor) store.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT);
		return { store, generation, locator, nonce };
	}

	it("test 11, one successor: no second generation is reserved for an endpoint while an earlier one is not retired", async () => {
		const { store, generation } = await crashed(false);
		expect(rejection(() => store.reserve(ENDPOINT, OWNER, ["supervisor"], NO_PRESENCE, NO_OBJECT))).toBe(
			"generation_active",
		);
		store.cancel(generation);
		expect(rejection(() => store.reserve(ENDPOINT, OWNER, ["supervisor"], NO_PRESENCE, NO_OBJECT))).toBe(
			"generation_active",
		);
		store.retire(generation, store.reservation(generation).revision, { owner: "process_gone" });
		const successor = store.reserve(ENDPOINT, OWNER, ["supervisor"], NO_PRESENCE, NO_OBJECT);
		expect(store.activeGenerations(ENDPOINT)).toEqual([successor]);
	});

	it("test 11: retirement needs the durable fence, the fenced revision and a discharge for every entry that held authority", async () => {
		const { store, generation } = await crashed(true);
		expect(rejection(() => store.retire(generation, store.reservation(generation).revision, {}))).toBe(
			"generation_not_fenced",
		);
		store.cancel(generation);
		const fenced = store.reservation(generation).revision;
		expect(
			rejection(() =>
				store.retire(generation, fenced - 1, { owner: "process_gone", supervisor: "presence_released" }),
			),
		).toBe("revision_changed");
		// The reserving owner (no `released`) and the granted supervisor each need their own proof.
		expect(rejection(() => store.retire(generation, fenced, { owner: "process_gone" }))).toBe("discharge_incomplete");
		expect(rejection(() => store.retire(generation, fenced, { supervisor: "presence_released" }))).toBe(
			"discharge_incomplete",
		);
		expect(store.reservation(generation).state).toBe("cancelling");
		store.retire(generation, fenced, { owner: "process_gone", supervisor: "presence_released" });
		expect(store.reservation(generation)).toMatchObject({
			state: "retired",
			retirement: {
				fencedRevision: fenced,
				discharges: { owner: "process_gone", supervisor: "presence_released" },
			},
		});
	});

	it("test 11: a release committed after the fence changes the revision, so a census taken before it cannot retire", async () => {
		const { store, generation } = await crashed(true);
		store.cancel(generation);
		const fenced = store.reservation(generation).revision;
		store.release(generation, "supervisor", SUPERVISOR);
		expect(
			rejection(() => store.retire(generation, fenced, { owner: "process_gone", supervisor: "presence_released" })),
		).toBe("revision_changed");
		// Recomputed at the new revision, the role's own `released` commit discharges it.
		store.retire(generation, store.reservation(generation).revision, { owner: "process_gone" });
		expect(store.reservation(generation).retirement?.discharges).toEqual({
			owner: "process_gone",
			supervisor: "released",
		});
	});

	it("test 11: a claimed-but-ungranted role is discharged by the fence and its state history, never by a proof", async () => {
		const { store, generation } = await crashed(false);
		store.cancel(generation);
		const fenced = store.reservation(generation).revision;
		expect(
			rejection(() => store.retire(generation, fenced, { owner: "process_gone", supervisor: "process_gone" })),
		).toBe("discharge_incomplete");
		store.retire(generation, fenced, { owner: "presence_released" });
		expect(store.reservation(generation).retirement?.discharges).toEqual({
			owner: "presence_released",
			supervisor: "never_granted",
		});
	});

	it("a serving generation whose owner and supervisor committed `released` needs proof only for its granted host", async () => {
		const store = await open();
		const generation = store.reserve(ENDPOINT, OWNER, ["supervisor", "host"], NO_PRESENCE, NO_OBJECT);
		for (const [role, participant, issuer] of [
			["supervisor", SUPERVISOR, OWNER],
			["host", HOST, SUPERVISOR],
		] as const) {
			store.offer(generation, role, issuer, NO_OBJECT);
			const locator = { endpoint: ENDPOINT, generation, role };
			store.claim(locator, store.readOffer(locator), participant);
			store.grant(generation, role, issuer, participant, COMMITMENT);
		}
		store.markServing(generation);
		store.releaseOwner(generation, OWNER);
		store.release(generation, "supervisor", SUPERVISOR);
		store.cancel(generation);
		const fenced = store.reservation(generation).revision;
		expect(rejection(() => store.retire(generation, fenced, {}))).toBe("discharge_incomplete");
		store.retire(generation, fenced, { host: "presence_released" });
		expect(store.reservation(generation).retirement?.discharges).toEqual({
			owner: "released",
			supervisor: "released",
			host: "presence_released",
		});
	});

	it("test 11/22: a retired generation is a tombstone; late claims, replayed nonces and stale grants fail before and after retirement", async () => {
		const store = await open();
		const generation = store.reserve(ENDPOINT, OWNER, ["supervisor", "host"], NO_PRESENCE, NO_OBJECT);
		store.offer(generation, "supervisor", OWNER, NO_OBJECT);
		const locator = { endpoint: ENDPOINT, generation, role: "supervisor" as const };
		const nonce = store.readOffer(locator);
		store.cancel(generation);
		// Before retirement: the fence already refuses the late wrapper's claim and the issuer's grant.
		expect(rejection(() => store.claim(locator, nonce, SUPERVISOR))).toBe("generation_cancelled");
		expect(rejection(() => store.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT))).toBe(
			"generation_cancelled",
		);
		store.retire(generation, store.reservation(generation).revision, { owner: "process_gone" });
		const retired = store.reservation(generation).revision;
		expect(rejection(() => store.claim(locator, nonce, SUPERVISOR))).toBe("generation_retired");
		expect(rejection(() => store.readOffer(locator))).toBe("generation_retired");
		expect(rejection(() => store.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT))).toBe(
			"generation_retired",
		);
		expect(rejection(() => store.offer(generation, "host", OWNER, NO_OBJECT))).toBe("generation_retired");
		expect(rejection(() => store.markServing(generation))).toBe("generation_retired");
		expect(rejection(() => store.cancel(generation))).toBe("generation_retired");
		expect(rejection(() => store.retire(generation, retired, { owner: "process_gone" }))).toBe("generation_retired");
		expect(store.reservation(generation)).toMatchObject({ state: "retired", revision: retired });
		expect(store.roleRow(locator)).toMatchObject({ status: "revoked", participant: null });
		expect(store.activeGenerations(ENDPOINT)).toEqual([]);
	});
});
