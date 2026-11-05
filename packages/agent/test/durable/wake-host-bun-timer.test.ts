// senpi#4733 (R1.d): the Bun timer host: real timers, sleep, restart, replaced instances and the epoch fence.
import { describe, expect, it } from "vitest";
import { DurableStoreError } from "../../src/durable/store.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createManualTimers, type ManualTimers } from "../../src/durable/testing/manual-timers.ts";
import { createBunTimerHost } from "../../src/durable/wake-host-bun-timer.ts";
import { storeAlarmPersistence } from "../../src/durable/wake-host-store-alarm.ts";

const T0 = 1_800_000_000_000;
const rethrow = (_key: string, error: unknown): never => {
	throw error;
};

async function claimedStore() {
	const medium = createMemoryStoreMedium();
	const store = openMemoryStore(medium);
	await store.claim(0, 1);
	return { medium, store };
}

/** Timers whose delays run on a monotonic clock that stops while the machine sleeps; the wall clock does not. */
function sleepingMachine(start: number): ManualTimers & { sleep(ms: number): void } {
	const monotonic = createManualTimers(0);
	let slept = 0;
	return {
		now: () => start + monotonic.now() + slept,
		setTimer: monotonic.setTimer,
		advanceTo: (at) => monotonic.advanceTo(at - start - slept),
		sleep: (ms) => {
			slept += ms;
		},
	};
}

describe("the Bun timer host", () => {
	it("fires an armed alarm on real timers", async () => {
		const { store } = await claimedStore();
		const errors: unknown[] = [];
		const host = createBunTimerHost({ maxDelayMs: 50, onFireError: (_key, error) => void errors.push(error) });
		const fired = Promise.withResolvers<number>();
		const alarm = await host.openAlarm("s", storeAlarmPersistence(store, 1), async () => fired.resolve(Date.now()));
		const armedAt = Date.now() + 5;
		await alarm.set(armedAt);
		const bound = AbortSignal.timeout(5_000);
		const timedOut = new Promise<never>((_, reject) => {
			bound.addEventListener("abort", () => reject(new Error("the alarm did not fire within 5 s")));
		});
		try {
			expect(await Promise.race([fired.promise, timedOut])).toBeGreaterThanOrEqual(armedAt);
			expect(errors).toEqual([]);
		} finally {
			host.close();
		}
	});

	it("delivers an alarm that fell due while the machine slept at the next bounded re-check", async () => {
		const { store } = await claimedStore();
		const clock = sleepingMachine(T0);
		const host = createBunTimerHost({ now: clock.now, setTimer: clock.setTimer, onFireError: rethrow });
		const fires: number[] = [];
		const alarm = await host.openAlarm(
			"s",
			storeAlarmPersistence(store, 1),
			async () => void fires.push(clock.now()),
		);
		await alarm.set(T0 + 3_600_000);
		clock.sleep(7_200_000);
		await clock.advanceTo(clock.now() + 60_000);
		expect(fires).toEqual([T0 + 7_260_000]);
		host.close();
	});

	it("fires a persisted alarm that is already due as soon as it is opened after a restart", async () => {
		const { store } = await claimedStore();
		const timers = createManualTimers(T0);
		const before = createBunTimerHost({ ...timers, onFireError: rethrow });
		await (await before.openAlarm("s", storeAlarmPersistence(store, 1), async () => {})).set(T0 + 1_000);
		before.close();
		await timers.advanceTo(T0 + 5_000);

		const after = createBunTimerHost({ ...timers, onFireError: rethrow });
		let fires = 0;
		await after.openAlarm("s", storeAlarmPersistence(store, 1), async () => void fires++);
		await timers.advanceTo(T0 + 5_000);
		expect(fires).toBe(1);
		after.close();
	});

	it("delivers to the newest instance only and refuses writes from a replaced one", async () => {
		const { store } = await claimedStore();
		const timers = createManualTimers(T0);
		const host = createBunTimerHost({ ...timers, onFireError: rethrow });
		const fired: string[] = [];
		const old = await host.openAlarm("s", storeAlarmPersistence(store, 1), async () => void fired.push("old"));
		await old.set(T0 + 1_000);
		const current = await host.openAlarm("s", storeAlarmPersistence(store, 1), async () => void fired.push("new"));
		await expect(old.set(T0 + 2_000)).rejects.toThrow(/replaced/);
		await timers.advanceTo(T0 + 1_000);
		expect(fired).toEqual(["new"]);
		expect(await current.read()).toBe(T0 + 1_000);
		host.close();
	});

	it("persists the alarm under the owner epoch, so an old owner cannot arm it", async () => {
		const { medium, store } = await claimedStore();
		await store.claim(1, 2);
		const stale = storeAlarmPersistence(openMemoryStore(medium), 1);
		await expect(stale.write(T0)).rejects.toBeInstanceOf(DurableStoreError);
		await storeAlarmPersistence(store, 2).write(T0);
		expect(await stale.read()).toBe(T0);
	});
});
