import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { retryWhenBusy } from "../../../src/modes/rpc/endpoint-reservation-busy.ts";
import { openEndpointReservationStore } from "../../../src/modes/rpc/endpoint-reservation-store.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Reservation through
// startup"). Contract: SQLite's own busy wait stays short because it blocks the event loop, so a caller retries a
// store_busy refusal under a bounded policy that waits asynchronously between attempts; it ends with the typed
// store_busy refusal and never retries a domain refusal.
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";

describe("reservation store busy retry", () => {
	const roots: string[] = [];
	const writers: DatabaseSync[] = [];

	afterEach(async () => {
		for (const writer of writers.splice(0)) if (writer.isOpen) writer.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function heldStore() {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-busy-"));
		roots.push(root);
		const path = join(root, "endpoint.reservation.db");
		const store = await openEndpointReservationStore(path);
		const generation = store.reserve(ENDPOINT, "owner", ["host"]);
		const writer = new DatabaseSync(path);
		writers.push(writer);
		writer.exec("BEGIN EXCLUSIVE; UPDATE reservations SET revision = revision;");
		return { path, store, generation, writer };
	}

	it("retries a read blocked by an exclusive writer until the writer lets go", async () => {
		const { store, generation, writer } = await heldStore();
		const waits: number[] = [];
		const row = await retryWhenBusy(() => store.reservation(generation), {
			attempts: 3,
			wait: async (attempt) => {
				waits.push(attempt);
				writer.exec("ROLLBACK;");
			},
		});
		expect(row).toMatchObject({ generation, state: "pending" });
		expect(waits).toEqual([1]);
		store.close();
	});

	it("retries opening a store held by an exclusive writer", async () => {
		const { path, store, writer } = await heldStore();
		store.close();
		const reopened = await retryWhenBusy(() => openEndpointReservationStore(path), {
			attempts: 2,
			wait: async () => writer.exec("ROLLBACK;"),
		});
		reopened.close();
	});

	it("ends with a typed store_busy refusal after the bounded attempts", async () => {
		const { store, generation } = await heldStore();
		const waits: number[] = [];
		await expect(
			retryWhenBusy(() => store.reservation(generation), {
				attempts: 3,
				wait: async (attempt) => {
					waits.push(attempt);
				},
			}),
		).rejects.toMatchObject({ reason: "store_busy" });
		expect(waits).toEqual([1, 2]);
		store.close();
	});

	it("never retries a domain refusal", async () => {
		const { store, writer } = await heldStore();
		writer.exec("ROLLBACK;");
		const waits: number[] = [];
		await expect(
			retryWhenBusy(() => store.reservation("0".repeat(32)), {
				attempts: 3,
				wait: async (attempt) => {
					waits.push(attempt);
				},
			}),
		).rejects.toMatchObject({ reason: "generation_unknown" });
		expect(waits).toEqual([]);
		store.close();
	});
});
