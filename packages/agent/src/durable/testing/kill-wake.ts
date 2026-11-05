import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "./store-harness.ts";
import {
	type BootOptions,
	createSlot,
	cutAlarm,
	cutStore,
	cutWake,
	expectWakeCut,
	HEARTBEAT_MS,
	type SessionInstance,
	type SessionSlot,
	type WakeCaseAdapters,
} from "./wake-harness.ts";

/** Where a KILL-WAKE case applies; a host report logs it in kill[] with the registry's expected outcome. */
export interface KillWakeDeclaration {
	readonly id: string;
	readonly operation: "admit" | "commit" | "update" | "fire";
	readonly point: string;
	readonly placement: "everywhere";
}

type KillWakeCase = KillWakeDeclaration & { readonly run: CaseImplementation<WakeCaseAdapters> };

const killCase = (
	id: string,
	operation: KillWakeDeclaration["operation"],
	point: string,
	run: CaseImplementation<WakeCaseAdapters>,
): KillWakeCase => ({ id, operation, point, placement: "everywhere", run });

const LATER = 600_000;
const DUE = 120_000;

async function killedAdmission(adapters: WakeCaseAdapters, cut: BootOptions): Promise<SessionSlot> {
	const slot = await createSlot(adapters);
	const { host, loop } = await slot.instance(cut);
	await expectWakeCut(
		host.admit(() => loop.schedule("a", slot.base + LATER)),
		"the killed admission",
	);
	slot.kill();
	return slot;
}

/** Recovery with no request from anyone: only the armed alarm brings the session back. */
async function recoversThroughHeartbeat(adapters: WakeCaseAdapters, slot: SessionSlot): Promise<void> {
	expectEqual(await slot.alarmAt(), HEARTBEAT_MS, "the pre-armed heartbeat survived the kill");
	await adapters.wake.advanceTo(slot.base + HEARTBEAT_MS);
	expectEqual(await slot.alarmAt(), LATER, "the heartbeat's instance armed the committed wake");
	await adapters.wake.advanceTo(slot.base + LATER);
	expectEqual(await slot.ran(), ["a"], "the committed task ran exactly once");
	expectEqual(await slot.alarmAt(), undefined, "and the alarm is cleared");
}

async function killedFire(adapters: WakeCaseAdapters, cut: BootOptions): Promise<SessionSlot> {
	const slot = await createSlot(adapters);
	const { host, loop } = await slot.instance(cut);
	await host.admit(() => loop.schedule("a", slot.base + DUE));
	await adapters.wake.advanceTo(slot.base + DUE);
	expectEqual(slot.fires(), 1, "the alarm fired into the instance that is killed");
	return slot;
}

async function recoversAfterKilledFire(adapters: WakeCaseAdapters, slot: SessionSlot): Promise<void> {
	expectEqual(await slot.alarmAt(), DUE + HEARTBEAT_MS, "the fire's re-arm survived the kill");
	await adapters.wake.advanceTo(slot.base + DUE + HEARTBEAT_MS);
	expectEqual(await slot.ran(), ["a"], "the task ran exactly once");
	expectEqual(await slot.alarmAt(), undefined, "and the alarm is cleared");
	await adapters.wake.advanceTo(slot.base + LATER);
	expectEqual(slot.fires(), 2, "no fire beyond the recovery");
}

/**
 * An admission B runs while a fire resumes other work on the same instance. The fire's updates see an idle loop (B's
 * task is not committed yet), so they must not clear the heartbeat B armed; B is killed after its commit is durable,
 * before its own update. The session runs at epoch 2.
 */
async function admissionDuringFire(adapters: WakeCaseAdapters): Promise<SessionSlot> {
	const fireDone = Promise.withResolvers<void>();
	let admission: Promise<void> | undefined;
	let session: SessionInstance | undefined;
	const slot = await createSlot(adapters, 2);
	const first = await slot.instance({
		store: cutStore("commit", "durable", 3),
		onWakePoint: (point) => {
			if (point.op !== "fire" || session === undefined || admission !== undefined) return;
			const { host, loop } = session;
			admission = host.admit(async () => {
				await fireDone.promise;
				await loop.schedule("b", slot.base + LATER);
			});
		},
	});
	session = first;
	await first.host.admit(() => first.loop.schedule("a", slot.base + DUE));
	await adapters.wake.advanceTo(slot.base + DUE);
	expectEqual(await slot.ran(), ["a"], "the fire resumed its due task");
	if (admission === undefined) throw new Error("the admission did not start during the fire");
	fireDone.resolve();
	await expectWakeCut(admission, "the admission killed after its commit");
	slot.kill();
	return slot;
}

const KILL_CASES: readonly KillWakeCase[] = [
	killCase("KILL-WAKE-01", "admit", "alarm write before durable", async (adapters) => {
		const slot = await killedAdmission(adapters, { alarm: cutAlarm("set", "before", 2) });
		expectEqual(await slot.alarmAt(), undefined, "nothing of the admission is durable");
		const { host, loop } = await slot.instance();
		await host.admit(() => loop.schedule("a", slot.base + LATER));
		await adapters.wake.advanceTo(slot.base + LATER);
		expectEqual(await slot.ran(), ["a"], "the retried admission runs once");
	}),
	killCase("KILL-WAKE-02", "admit", "after the arm, before work", async (adapters) => {
		const slot = await killedAdmission(adapters, { onWakePoint: cutWake("admit") });
		expectEqual(await slot.alarmAt(), HEARTBEAT_MS, "the arm is durable");
		await adapters.wake.advanceTo(slot.base + HEARTBEAT_MS);
		expectEqual(await slot.ran(), [], "an alarm without work runs nothing");
		expectEqual(await slot.alarmAt(), undefined, "and ends cleared");
		expectEqual(slot.fires(), 1, "one harmless fire");
	}),
	killCase("KILL-WAKE-03", "commit", "after the commit is durable, before the alarm update", async (adapters) => {
		const slot = await killedAdmission(adapters, { store: cutStore("commit", "durable") });
		await recoversThroughHeartbeat(adapters, slot);
	}),
	killCase("KILL-WAKE-04", "update", "eviction during the alarm write", async (adapters) => {
		const slot = await killedAdmission(adapters, { alarm: cutAlarm("set", "before", 3) });
		await recoversThroughHeartbeat(adapters, slot);
	}),
	killCase("KILL-WAKE-05", "fire", "after the re-arm, before resume", async (adapters) => {
		const slot = await killedFire(adapters, { onWakePoint: cutWake("fire") });
		expectEqual(await slot.ran(), [], "nothing ran before the kill");
		await recoversAfterKilledFire(adapters, slot);
	}),
	killCase("KILL-WAKE-06", "fire", "after a resumed task's commit is durable", async (adapters) => {
		const slot = await killedFire(adapters, { store: cutStore("commit", "durable", 2) });
		expectEqual(await slot.ran(), ["a"], "the task's commit is durable");
		await recoversAfterKilledFire(adapters, slot);
	}),
	killCase("KILL-WAKE-07", "fire", "eviction during the alarm clear after the work", async (adapters) => {
		const slot = await killedFire(adapters, { alarm: cutAlarm("clear", "before", 2) });
		expectEqual(await slot.ran(), ["a"], "the work is durable");
		await recoversAfterKilledFire(adapters, slot);
	}),
	killCase(
		"KILL-WAKE-08",
		"admit",
		"a concurrent fire's updates while the admission is uncommitted, then a kill after its commit",
		async (adapters) => {
			const slot = await admissionDuringFire(adapters);
			expectEqual(await slot.alarmAt(), DUE + HEARTBEAT_MS, "the admission's heartbeat outlived the fire's updates");
			await adapters.wake.advanceTo(slot.base + DUE + HEARTBEAT_MS);
			expectEqual(await slot.alarmAt(), LATER, "the heartbeat's instance armed the committed wake");
			await adapters.wake.advanceTo(slot.base + LATER);
			expectEqual(await slot.ran(), ["a", "b"], "each task ran exactly once");
			expectEqual(await slot.alarmAt(), undefined, "and the alarm is cleared");
		},
	),
];

export const KILL_WAKE_DECLARATIONS: readonly KillWakeDeclaration[] = KILL_CASES.map(
	({ id, operation, point, placement }) => ({ id, operation, point, placement }),
);

export const KILL_WAKE_CASES: ReadonlyMap<string, CaseImplementation<WakeCaseAdapters>> = new Map(
	KILL_CASES.map(({ id, run }) => [id, run]),
);
