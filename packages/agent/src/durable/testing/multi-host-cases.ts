import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "./store-harness.ts";
import { createSlot, type SessionSlot, type WakeCaseAdapters } from "./wake-harness.ts";

type MultiHostCase = CaseImplementation<WakeCaseAdapters>;

async function schedule(slot: SessionSlot, id: string, offset: number): Promise<void> {
	const { host, loop } = await slot.instance();
	await host.admit(() => loop.schedule(id, slot.base + offset));
}

const observe = async (slots: readonly SessionSlot[]) => ({
	fires: slots.map((slot) => slot.fires()),
	ran: await Promise.all(slots.map((slot) => slot.ran())),
	alarms: await Promise.all(slots.map((slot) => slot.alarmAt())),
});

const manySessionsOnOneHost: MultiHostCase = async (adapters) => {
	const slots = [await createSlot(adapters), await createSlot(adapters), await createSlot(adapters)];
	const [first, second, third] = slots;
	if (first === undefined || second === undefined || third === undefined) throw new Error("three sessions");
	await schedule(first, "x", 120_000);
	await schedule(first, "y", 300_000);
	await schedule(second, "x", 200_000);
	await third.instance();
	expectEqual(
		await observe(slots),
		{ fires: [0, 0, 0], ran: [[], [], []], alarms: [120_000, 200_000, undefined] },
		"armed per session",
	);

	second.kill();
	await adapters.wake.advanceTo(first.base + 120_000);
	expectEqual(
		await observe(slots),
		{ fires: [1, 0, 0], ran: [["x"], [], []], alarms: [300_000, 200_000, undefined] },
		"a fire resumes only its own session; the same task ID elsewhere is untouched",
	);

	third.kill();
	await third.instance();
	expectEqual(
		(await observe(slots)).alarms,
		[300_000, 200_000, undefined],
		"restarting one session moves no other session's alarm",
	);

	await adapters.wake.advanceTo(first.base + 300_000);
	expectEqual(
		await observe(slots),
		{ fires: [2, 1, 0], ran: [["x", "y"], ["x"], []], alarms: [undefined, undefined, undefined] },
		"an evicted session comes back on its own alarm; records and wakes stay per session",
	);
};

export const MULTI_HOST_CASES: ReadonlyMap<string, MultiHostCase> = new Map([["MULTI-HOST-01", manySessionsOnOneHost]]);
