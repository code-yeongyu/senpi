import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "./store-harness.ts";
import { createSlot, HEARTBEAT_MS, restartHost, type WakeCaseAdapters } from "./wake-harness.ts";

type WakeCase = CaseImplementation<WakeCaseAdapters>;

const TEN_MINUTES = 600_000;

const preArm: WakeCase = async (adapters) => {
	const slot = await createSlot(adapters);
	const session = await slot.instance();
	expectEqual(slot.trace, [`set:+${HEARTBEAT_MS}`, "resume", "clear"], "start arms a fallback before it resumes");

	slot.trace.length = 0;
	await session.host.admit(async () => {
		slot.trace.push(`work alarm=+${await slot.alarmAt()}`);
	});
	expectEqual(
		slot.trace,
		[`set:+${HEARTBEAT_MS}`, `work alarm=+${HEARTBEAT_MS}`, "clear"],
		"admit arms durably before work starts, and arms from the idle loop's wake when the work ends",
	);

	const failing = session.host.admit(async () => {
		throw new Error("work failed");
	});
	await failing.then(
		() => {
			throw new Error("a failing admission resolved");
		},
		() => undefined,
	);
	expectEqual(await slot.alarmAt(), HEARTBEAT_MS, "work that fails leaves the recovery alarm armed");

	await session.host.admit(() => session.loop.schedule("late", slot.base + TEN_MINUTES));
	slot.kill();
	slot.trace.length = 0;
	await slot.instance();
	expectEqual(
		slot.trace,
		[`set:+${HEARTBEAT_MS}`, "resume", `set:+${TEN_MINUTES}`],
		"a new instance lowers a later alarm to the fallback before resuming",
	);

	await (await slot.instance()).host.update({ active: false, at: slot.base + 30_000 });
	slot.kill();
	slot.trace.length = 0;
	await slot.instance();
	expectEqual(slot.trace, ["resume", `set:+${TEN_MINUTES}`], "an earlier alarm is kept as the fallback");
};

const update: WakeCase = async (adapters) => {
	const slot = await createSlot(adapters);
	const { host, loop } = await slot.instance();
	const schedule = (id: string, offset: number) => host.admit(() => loop.schedule(id, slot.base + offset));

	slot.trace.length = 0;
	await schedule("a", TEN_MINUTES);
	expectEqual(
		slot.trace,
		[`set:+${HEARTBEAT_MS}`, `set:+${HEARTBEAT_MS}`, `set:+${TEN_MINUTES}`],
		"the commit's update keeps the heartbeat while the admission is in flight; after it, the alarm is the wake",
	);
	await schedule("b", 300_000);
	expectEqual(await slot.alarmAt(), 300_000, "an earlier wake lowers the alarm");
	await schedule("c", 900_000);
	expectEqual(await slot.alarmAt(), 300_000, "a later wake never raises it past the earliest");

	await host.update({ active: true, at: slot.base + 300_000 });
	expectEqual(await slot.alarmAt(), HEARTBEAT_MS, "while active, a heartbeat earlier than the wake");
	await host.update({ active: true, at: slot.base + 30_000 });
	expectEqual(await slot.alarmAt(), 30_000, "never later than the earliest wake");
	await host.update({ active: false });
	expectEqual(await slot.alarmAt(), undefined, "cleared only when the loop is idle");
	expectEqual(await slot.ran(), [], "updates run nothing");
};

const resume: WakeCase = async (adapters) => {
	const slot = await createSlot(adapters);
	const { host, loop } = await slot.instance();
	for (const [id, offset] of [
		["a", 120_000],
		["b", 120_000],
		["c", TEN_MINUTES],
	] as const) {
		await host.admit(() => loop.schedule(id, slot.base + offset));
	}

	slot.trace.length = 0;
	await adapters.wake.advanceTo(slot.base + 120_000);
	expectEqual(slot.fires(), 1, "one fire at the wake");
	expectEqual(slot.trace.slice(0, 2), [`set:+${120_000 + HEARTBEAT_MS}`, "resume"], "a fire re-arms before resume");
	expectEqual(await slot.ran(), ["a", "b"], "the due tasks run once, in order");
	expectEqual(await slot.alarmAt(), TEN_MINUTES, "then the alarm is the next wake");

	await host.update({ active: true });
	await adapters.wake.advanceTo(slot.base + 120_000 + HEARTBEAT_MS);
	expectEqual(await slot.ran(), ["a", "b"], "an early alarm runs nothing");
	expectEqual(await slot.alarmAt(), TEN_MINUTES, "and re-arms from the loop's wake");

	await adapters.wake.advanceTo(slot.base + TEN_MINUTES);
	expectEqual(await slot.ran(), ["a", "b", "c"], "the last task runs at its wake");
	expectEqual(await slot.alarmAt(), undefined, "an idle loop leaves no alarm");
	expectEqual(slot.fires(), 3, "no fire beyond the alarms armed");
};

const retention: WakeCase = async (adapters) => {
	const slot = await createSlot(adapters);
	const { host, loop } = await slot.instance();
	await host.admit(() => loop.schedule("a", slot.base + TEN_MINUTES));

	await restartHost(adapters, [slot]);
	expectEqual(await slot.alarmAt(), TEN_MINUTES, "the alarm is durable across a host restart");
	await slot.instance();
	slot.kill();
	await slot.instance();
	expectEqual(await slot.alarmAt(), TEN_MINUTES, "reopened instances keep it");

	await adapters.wake.advanceTo(slot.base + TEN_MINUTES - 1);
	expectEqual(slot.fires(), 0, "nothing fires early, whatever instances came and went");
	await adapters.wake.advanceTo(slot.base + TEN_MINUTES);
	expectEqual(slot.fires(), 1, "it fires once");
	expectEqual(await slot.ran(), ["a"], "the task runs once");
	expectEqual(await slot.alarmAt(), undefined, "and the alarm is not retained after the work");
	await adapters.wake.advanceTo(slot.base + 3 * TEN_MINUTES);
	expectEqual(slot.fires(), 1, "a consumed alarm never fires again");
};

export const WAKE_CASES: ReadonlyMap<string, WakeCase> = new Map([
	["WAKE-01", preArm],
	["WAKE-02", update],
	["WAKE-03", resume],
	["WAKE-RET-01", retention],
]);
