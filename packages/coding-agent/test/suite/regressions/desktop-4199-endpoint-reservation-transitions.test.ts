import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EndpointReservationError,
	EndpointReservationStore,
	openEndpointReservationStore,
} from "../../../src/modes/rpc/endpoint-reservation-store.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Wrapper-safe
// discovery and one-time claim" and "Crash, cancellation and commit"). Security contract: a claim retry is answered from
// what the role's row records now, so a granted role never reads as merely claimed and a released one is never
// re-admitted; a transition that fails reports its own failure, even when its ROLLBACK fails too.
const OWNER = '{"pid":100,"creationTime":"133000000000000001","userSid":"S-1-5-21-1"}';
const SUPERVISOR = '{"pid":200,"creationTime":"133000000000000002","userSid":"S-1-5-21-1"}';
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const COMMITMENT = createHash("sha256").update(randomBytes(32)).digest();

describe("endpoint reservation transitions", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function granted() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-transitions-"));
		roots.push(root);
		const store = await openEndpointReservationStore(join(root, "endpoint.reservation.db"));
		const generation = store.reserve(ENDPOINT, OWNER, ["supervisor", "host"]);
		store.offer(generation, "supervisor", OWNER);
		const locator = { endpoint: ENDPOINT, generation, role: "supervisor" as const };
		const nonce = store.readOffer(locator);
		store.claim(locator, nonce, SUPERVISOR);
		store.grant(generation, "supervisor", OWNER, SUPERVISOR, COMMITMENT);
		return { store, generation, locator, nonce };
	}

	it("answers a claim retry by the granted participant as already granted, not merely claimed", async () => {
		const { store, generation, locator, nonce } = await granted();
		const before = store.reservation(generation).revision;
		expect(store.claim(locator, nonce, SUPERVISOR)).toBe("already_granted_to_caller");
		expect(store.reservation(generation).revision).toBe(before);
		store.close();
	});

	it("refuses a claim retry once the participant released the role", async () => {
		const { store, generation, locator, nonce } = await granted();
		store.release(generation, "supervisor", SUPERVISOR);
		let reason: string | undefined;
		try {
			store.claim(locator, nonce, SUPERVISOR);
		} catch (error) {
			if (!(error instanceof EndpointReservationError)) throw error;
			reason = error.reason;
		}
		expect(reason).toBe("role_released");
		expect(store.roleRow(locator)).toMatchObject({ status: "released", participant: SUPERVISOR });
		store.close();
	});

	it("rethrows a transition's own failure when its ROLLBACK fails too, with the rollback failure attached", () => {
		const original = new Error("disk I/O error");
		const rollback = new Error("cannot rollback - no transaction is active");
		const executed: string[] = [];
		const store = new EndpointReservationStore({
			exec: (sql: string) => {
				executed.push(sql);
				if (sql === "ROLLBACK") throw rollback;
			},
			prepare: () => ({
				run: () => {
					throw original;
				},
				get: () => undefined,
				all: () => [],
			}),
			close: () => undefined,
		});
		let thrown: unknown;
		try {
			store.reserve(ENDPOINT, OWNER, ["host"]);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBe(original);
		expect(thrown).toMatchObject({ rollbackError: rollback });
		expect(executed).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
	});
});
