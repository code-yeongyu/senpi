import { describe, expect, it } from "vitest";
import {
	createLoopScheduler,
	DEFAULT_KEEPALIVE_SECONDS,
	DEFAULT_MAX_TICKS,
	LOOP_EXPIRY_MS,
	type LoopSchedulerDeps,
	type LoopTimerPort,
	MAX_ACTIVE_LOOPS,
} from "../../src/core/extensions/builtin/loop/scheduler.ts";
import type {
	CronEntry,
	DynamicCronEntry,
	FixedCronEntry,
	LoopEndReason,
	LoopState,
} from "../../src/core/extensions/builtin/loop/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

/** Fake timer port: records armed keys and lets the test fire them explicitly. */
class FakeTimers implements LoopTimerPort {
	readonly armed = new Map<string, { dueAt: number; callback: () => void }>();
	readonly armLog: Array<{ key: string; dueAt: number }> = [];
	readonly cancelLog: string[] = [];
	cancelAllCount = 0;

	arm(key: string, dueAt: number, callback: () => void): void {
		this.armed.set(key, { dueAt, callback });
		this.armLog.push({ key, dueAt });
	}

	cancel(key: string): void {
		if (this.armed.delete(key)) this.cancelLog.push(key);
	}

	cancelAll(): void {
		this.cancelAllCount += 1;
		this.armed.clear();
	}

	dueAt(key: string): number | undefined {
		return this.armed.get(key)?.dueAt;
	}

	/** Invokes the armed callback for a key, as a real timeout would. */
	fire(key: string): void {
		const entry = this.armed.get(key);
		if (entry === undefined) throw new Error(`no timer armed for ${key}`);
		entry.callback();
	}
}

interface Harness {
	readonly scheduler: ReturnType<typeof createLoopScheduler>;
	readonly timers: FakeTimers;
	setNow(value: number): void;
	advance(ms: number): void;
	now(): number;
}

function harness(
	options: {
		now?: number;
		env?: Record<string, string | undefined>;
		initialState?: LoopState;
		idPrefix?: string;
	} = {},
): Harness {
	let current = options.now ?? T0;
	const timers = new FakeTimers();
	const prefix = options.idPrefix ?? "";
	let loopSeq = 0;
	let wakeupSeq = 0;
	let deliverySeq = 0;
	const deps: LoopSchedulerDeps = {
		sessionId: "session-under-test",
		clock: { now: () => current },
		timers,
		ids: {
			loopId: () => `${prefix}loop-${++loopSeq}`,
			wakeupId: () => `${prefix}wakeup-${++wakeupSeq}`,
			deliveryId: () => `${prefix}delivery-${++deliverySeq}`,
		},
		env: options.env ?? {},
		...(options.initialState === undefined ? {} : { initialState: options.initialState }),
	};
	const scheduler = createLoopScheduler(deps);
	return {
		scheduler,
		timers,
		setNow: (value) => {
			current = value;
		},
		advance: (ms) => {
			current += ms;
		},
		now: () => current,
	};
}

function createFixedLoop(h: Harness, overrides: { intervalMs?: number; prompt?: string } = {}) {
	const intervalMs = overrides.intervalMs ?? 5 * MINUTE;
	return h.scheduler.createFixed({
		originalArgs: `5m ${overrides.prompt ?? "check the deploy"}`,
		reentryPrompt: `/loop 5m ${overrides.prompt ?? "check the deploy"}`,
		payload: { type: "prompt", prompt: overrides.prompt ?? "check the deploy" },
		requestedInterval: { value: 5, unit: "m", raw: "5m" },
		effectiveInterval: { value: 5, unit: "m", human: "5 minutes", rounded: false },
		cronExpression: "*/5 * * * *",
		intervalMs,
	});
}

function createDynamicLoop(h: Harness, prompt = "watch the queue") {
	return h.scheduler.createDynamic({
		originalArgs: prompt,
		reentryPrompt: `/loop ${prompt}`,
		payload: { type: "prompt", prompt },
	});
}

function expectFixed(entry: CronEntry | undefined): FixedCronEntry {
	if (entry === undefined || entry.kind !== "fixed") throw new Error("expected a fixed entry");
	return entry;
}

function expectDynamic(entry: CronEntry | undefined): DynamicCronEntry {
	if (entry === undefined || entry.kind !== "dynamic") throw new Error("expected a dynamic entry");
	return entry;
}

function loopEntry(h: Harness, loopId: string): CronEntry {
	const entry = h.scheduler.getState().entries[loopId];
	if (entry === undefined) throw new Error(`no entry for ${loopId}`);
	return entry;
}

/** Runs a full dispatched tick: due -> dispatch -> settled. */
function runTick(h: Harness, loopId: string): void {
	const due = h.scheduler.onDue(loopId, h.now(), false);
	if (due.action !== "dispatch") throw new Error(`expected dispatch, got ${due.action}`);
	h.scheduler.onTickSettled({ loopId, deliveryId: due.tick.deliveryId, outcome: "completed" });
}

describe("createFixed", () => {
	it("arms the next occurrence recomputed from now and returns the first tick", () => {
		const h = harness();
		const created = createFixedLoop(h);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const entry = expectFixed(loopEntry(h, created.loopId));
		expect(entry.kind).toBe("fixed");
		expect(entry.phase).toBe("waiting");
		expect(entry.nextFireAt).toBe(T0 + 5 * MINUTE);
		expect(entry.expiresAt).toBe(T0 + LOOP_EXPIRY_MS);
		expect(h.timers.dueAt(created.loopId)).toBe(T0 + 5 * MINUTE);
	});

	it("recomputes nextFireAt from now on every scheduled fire, never from the stale due time", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");

		// Timer callback lands 90s late (event-loop lag).
		h.setNow(T0 + 5 * MINUTE + 90_000);
		const due = h.scheduler.onDue(created.loopId, h.now(), false);
		expect(due.action).toBe("dispatch");

		const entry = expectFixed(loopEntry(h, created.loopId));
		expect(entry.nextFireAt).toBe(h.now() + 5 * MINUTE);
		expect(entry.nextFireAt).not.toBe(T0 + 10 * MINUTE);
		expect(h.timers.dueAt(created.loopId)).toBe(h.now() + 5 * MINUTE);
	});

	it("rejects a 6th active loop with a typed rejection while the 5 existing loops stay armed", () => {
		const h = harness();
		const ids: string[] = [];
		for (let i = 0; i < MAX_ACTIVE_LOOPS; i++) {
			const created = createFixedLoop(h, { prompt: `job ${i}` });
			expect(created.ok).toBe(true);
			if (created.ok) ids.push(created.loopId);
		}
		expect(ids).toHaveLength(5);

		const rejected = createFixedLoop(h, { prompt: "job 6" });
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.reason).toBe("active_loop_cap");
		expect(rejected.activeLoopIds).toEqual(ids);
		expect(rejected.cap).toBe(MAX_ACTIVE_LOOPS);
		expect(rejected.message).toMatch(/\/loop stop/);

		expect(Object.keys(h.scheduler.getState().entries)).toHaveLength(5);
		for (const id of ids) {
			expect(loopEntry(h, id).phase).toBe("waiting");
			expect(h.timers.dueAt(id)).toBe(T0 + 5 * MINUTE);
		}
	});
});

describe("createDynamic", () => {
	it("starts with keepalive credit 1 and no armed timer until the model schedules", () => {
		const h = harness();
		const created = createDynamicLoop(h);
		if (!created.ok) throw new Error("create failed");

		const entry = expectDynamic(loopEntry(h, created.loopId));
		expect(entry.keepaliveCredit).toBe(1);
		expect(entry.pendingWakeup).toBeNull();
		expect(h.scheduler.getState().activeDynamicId).toBe(created.loopId);
		expect(h.timers.armed.has(created.loopId)).toBe(false);
	});

	it("supersedes an existing dynamic loop in one mutation", () => {
		const h = harness();
		const first = createDynamicLoop(h, "first");
		if (!first.ok) throw new Error("create failed");
		h.scheduler.onScheduleWakeup({
			loopId: first.loopId,
			delaySeconds: 600,
			requestedDelaySeconds: 600,
			reason: "poll",
			prompt: "/loop first",
			noop: false,
		});
		expect(h.timers.armed.has(first.loopId)).toBe(true);
		const versionBefore = h.scheduler.getState().updatedAt;

		h.advance(MINUTE);
		const second = createDynamicLoop(h, "second");
		if (!second.ok) throw new Error("create failed");
		expect(second.supersededLoopId).toBe(first.loopId);

		const state = h.scheduler.getState();
		const old = expectDynamic(state.entries[first.loopId]);
		expect(old.phase).toBe("ended");
		expect(old.endReason).toBe("stopped");
		expect(old.endDetail).toBe("superseded");
		expect(state.activeDynamicId).toBe(second.loopId);
		expect(h.timers.armed.has(first.loopId)).toBe(false);
		// Both the end and the creation land in a single state revision.
		expect(state.updatedAt).toBe(h.now());
		expect(state.updatedAt).not.toBe(versionBefore);
		expect(h.scheduler.mutationCount).toBe(3);
	});
});

describe("onDue coalescing", () => {
	it("queues exactly one tick and sets coalescedFirePending for further due occurrences", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		h.advance(5 * MINUTE);
		const first = h.scheduler.onDue(loopId, h.now(), true);
		expect(first.action).toBe("dispatch");
		if (first.action !== "dispatch") return;
		expect(first.tick.deliverAs).toBe("followUp");
		expect(loopEntry(h, loopId).phase).toBe("queued");

		h.advance(5 * MINUTE);
		const second = h.scheduler.onDue(loopId, h.now(), true);
		h.advance(5 * MINUTE);
		const third = h.scheduler.onDue(loopId, h.now(), true);
		h.advance(5 * MINUTE);
		const fourth = h.scheduler.onDue(loopId, h.now(), true);

		expect(second.action).toBe("coalesce");
		expect(third.action).toBe("coalesce");
		expect(fourth.action).toBe("coalesce");

		const entry = expectFixed(loopEntry(h, loopId));
		expect(entry.coalescedFirePending).toBe(true);
		expect(entry.tickCount).toBe(1);
		// Coalescing still keeps the schedule moving forward from now.
		expect(entry.nextFireAt).toBe(h.now() + 5 * MINUTE);

		// Settling releases exactly one coalesced tick, and only one.
		const released = h.scheduler.onTickSettled({
			loopId,
			deliveryId: first.tick.deliveryId,
			outcome: "completed",
		});
		expect(released.action).toBe("dispatch");
		if (released.action !== "dispatch") return;
		expect(expectFixed(loopEntry(h, loopId)).coalescedFirePending).toBe(false);

		const settledAgain = h.scheduler.onTickSettled({
			loopId,
			deliveryId: released.tick.deliveryId,
			outcome: "completed",
		});
		expect(settledAgain.action).toBe("idle");
		expect(expectFixed(loopEntry(h, loopId)).tickCount).toBe(2);
	});

	it("dispatches through the injected timer callback and re-arms the replacement timer", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;
		expect(h.timers.armLog).toHaveLength(1);

		h.advance(5 * MINUTE);
		h.timers.fire(loopId);

		// The callback routed through onDue: the tick counted and a fresh timer was armed.
		expect(loopEntry(h, loopId).tickCount).toBe(1);
		expect(loopEntry(h, loopId).phase).toBe("running");
		expect(h.timers.armLog).toHaveLength(2);
		expect(h.timers.dueAt(loopId)).toBe(h.now() + 5 * MINUTE);
	});

	it("collapses a 3-day clock jump into exactly ONE tick with the next fire after now", () => {
		const h = harness();
		const created = createFixedLoop(h, { intervalMs: MINUTE });
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		h.advance(3 * DAY);
		let dispatches = 0;
		// The laptop wakes and the single armed timer fires once; the scheduler must never
		// replay the ~4320 missed occurrences.
		for (let i = 0; i < 10; i++) {
			const due = h.scheduler.onDue(loopId, h.now(), false);
			if (due.action === "dispatch") dispatches += 1;
		}
		expect(dispatches).toBe(1);

		const entry = expectFixed(loopEntry(h, loopId));
		expect(entry.tickCount).toBe(1);
		expect(entry.nextFireAt).toBeGreaterThan(h.now());
		expect(entry.nextFireAt).toBe(h.now() + MINUTE);
	});
});

describe("expiry", () => {
	it("expires at day 7 with no final tick, and never extends expiry via a new wakeup", () => {
		const h = harness();
		const created = createDynamicLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		h.advance(6 * DAY);
		const scheduled = h.scheduler.onScheduleWakeup({
			loopId,
			delaySeconds: 3600,
			requestedDelaySeconds: 3600,
			reason: "poll",
			prompt: "/loop watch the queue",
			noop: false,
		});
		expect(scheduled.ok).toBe(true);
		expect(expectDynamic(loopEntry(h, loopId)).expiresAt).toBe(T0 + LOOP_EXPIRY_MS);

		h.setNow(T0 + LOOP_EXPIRY_MS);
		const due = h.scheduler.onDue(loopId, h.now(), false);
		expect(due.action).toBe("expire");

		const entry = loopEntry(h, loopId);
		expect(entry.phase).toBe("ended");
		expect(requireEndReason(entry)).toBe("expired");
		expect(entry.tickCount).toBe(0);
		expect(entry.lastFiredAt).toBeNull();
		expect(h.timers.armed.has(loopId)).toBe(false);
	});

	it("expires a fixed loop at arm time instead of arming a post-expiry timer", () => {
		const h = harness();
		const created = createFixedLoop(h, { intervalMs: 12 * HOUR });
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		h.setNow(T0 + LOOP_EXPIRY_MS - HOUR);
		const due = h.scheduler.onDue(loopId, h.now(), false);
		expect(due.action).toBe("dispatch");
		// The next occurrence would land past expiry, so no timer may be armed for it.
		expect(loopEntry(h, loopId).phase).toBe("ended");
		expect(loopEntry(h, loopId).endReason).toBe("expired");
		expect(h.timers.armed.has(loopId)).toBe(false);
	});

	it("expires overdue entries on restore without firing a recovery tick", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		h.scheduler.onShutdown();
		h.setNow(T0 + LOOP_EXPIRY_MS + DAY);
		const restored = h.scheduler.restore(h.now());
		expect(restored.recoveryTicks).toHaveLength(0);
		expect(restored.expiredLoopIds).toEqual([loopId]);
		expect(loopEntry(h, loopId).endReason).toBe("expired");
	});
});

describe("keepalive two-strike", () => {
	it("arms exactly one fallback wakeup on the first omission and then ends keepalive_exhausted", () => {
		const h = harness();
		const created = createDynamicLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		const first = h.scheduler.onTurnEndedWithoutSchedule(loopId);
		expect(first.action).toBe("keepalive_armed");
		if (first.action !== "keepalive_armed") return;
		expect(first.delaySeconds).toBe(DEFAULT_KEEPALIVE_SECONDS);
		expect(first.dueAt).toBe(T0 + DEFAULT_KEEPALIVE_SECONDS * 1000);

		const armed = expectDynamic(loopEntry(h, loopId));
		expect(armed.keepaliveCredit).toBe(0);
		expect(armed.pendingWakeup?.source).toBe("keepalive");
		expect(h.timers.dueAt(loopId)).toBe(T0 + DEFAULT_KEEPALIVE_SECONDS * 1000);

		h.advance(DEFAULT_KEEPALIVE_SECONDS * 1000);
		runTick(h, loopId);

		const second = h.scheduler.onTurnEndedWithoutSchedule(loopId);
		expect(second.action).toBe("ended");
		if (second.action !== "ended") return;
		expect(second.endReason).toBe("keepalive_exhausted");

		const ended = loopEntry(h, loopId);
		expect(ended.phase).toBe("ended");
		expect(ended.endReason).toBe("keepalive_exhausted");
		expect(h.timers.armed.has(loopId)).toBe(false);
	});

	it("resets the credit to 1 when the model schedules successfully between omissions", () => {
		const h = harness();
		const created = createDynamicLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		expect(h.scheduler.onTurnEndedWithoutSchedule(loopId).action).toBe("keepalive_armed");
		expect(expectDynamic(loopEntry(h, loopId)).keepaliveCredit).toBe(0);

		h.advance(DEFAULT_KEEPALIVE_SECONDS * 1000);
		runTick(h, loopId);
		const scheduled = h.scheduler.onScheduleWakeup({
			loopId,
			delaySeconds: 900,
			requestedDelaySeconds: 900,
			reason: "recheck",
			prompt: "/loop watch the queue",
			noop: false,
		});
		expect(scheduled.ok).toBe(true);
		if (!scheduled.ok) return;
		expect(scheduled.replacedWakeupId).toBeUndefined();
		expect(expectDynamic(loopEntry(h, loopId)).keepaliveCredit).toBe(1);

		h.advance(900_000);
		runTick(h, loopId);
		const omission = h.scheduler.onTurnEndedWithoutSchedule(loopId);
		expect(omission.action).toBe("keepalive_armed");
		expect(loopEntry(h, loopId).phase).not.toBe("ended");
	});

	it("honors SENPI_LOOP_KEEPALIVE_SECONDS and clamps it to [60,3600]", () => {
		const low = harness({ env: { SENPI_LOOP_KEEPALIVE_SECONDS: "5" } });
		const lowLoop = createDynamicLoop(low);
		if (!lowLoop.ok) throw new Error("create failed");
		const lowResult = low.scheduler.onTurnEndedWithoutSchedule(lowLoop.loopId);
		expect(lowResult.action === "keepalive_armed" && lowResult.delaySeconds).toBe(60);

		const high = harness({ env: { SENPI_LOOP_KEEPALIVE_SECONDS: "999999" } });
		const highLoop = createDynamicLoop(high);
		if (!highLoop.ok) throw new Error("create failed");
		const highResult = high.scheduler.onTurnEndedWithoutSchedule(highLoop.loopId);
		expect(highResult.action === "keepalive_armed" && highResult.delaySeconds).toBe(3600);

		const custom = harness({ env: { SENPI_LOOP_KEEPALIVE_SECONDS: "300" } });
		const customLoop = createDynamicLoop(custom);
		if (!customLoop.ok) throw new Error("create failed");
		const customResult = custom.scheduler.onTurnEndedWithoutSchedule(customLoop.loopId);
		expect(customResult.action === "keepalive_armed" && customResult.delaySeconds).toBe(300);
	});

	it("never applies keepalive to a fixed loop", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		const result = h.scheduler.onTurnEndedWithoutSchedule(created.loopId);
		expect(result.action).toBe("ignored");
		expect(loopEntry(h, created.loopId).phase).toBe("waiting");
	});

	it("keeps a dynamic loop alive after a provider error, which is never terminal", () => {
		const h = harness();
		const created = createDynamicLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;
		h.scheduler.onScheduleWakeup({
			loopId,
			delaySeconds: 600,
			requestedDelaySeconds: 600,
			reason: "poll",
			prompt: "/loop watch the queue",
			noop: false,
		});

		h.advance(600_000);
		const due = h.scheduler.onDue(loopId, h.now(), false);
		if (due.action !== "dispatch") throw new Error("expected dispatch");
		h.scheduler.onTickSettled({ loopId, deliveryId: due.tick.deliveryId, outcome: "error" });

		expect(loopEntry(h, loopId).phase).not.toBe("ended");
		expect(expectDynamic(loopEntry(h, loopId)).keepaliveCredit).toBe(1);

		// A fixed loop's provider error is equally nonterminal and leaves the schedule armed.
		const fixed = createFixedLoop(h);
		if (!fixed.ok) throw new Error("create failed");
		h.advance(5 * MINUTE);
		const fixedDue = h.scheduler.onDue(fixed.loopId, h.now(), false);
		if (fixedDue.action !== "dispatch") throw new Error("expected dispatch");
		h.scheduler.onTickSettled({ loopId: fixed.loopId, deliveryId: fixedDue.tick.deliveryId, outcome: "error" });
		expect(loopEntry(h, fixed.loopId).phase).toBe("waiting");
		expect(h.timers.armed.has(fixed.loopId)).toBe(true);
	});

	it("does not run keepalive for a retrying turn that is still in progress", () => {
		const h = harness();
		const created = createDynamicLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;
		h.scheduler.onScheduleWakeup({
			loopId,
			delaySeconds: 600,
			requestedDelaySeconds: 600,
			reason: "poll",
			prompt: "/loop watch the queue",
			noop: false,
		});
		h.advance(600_000);
		const due = h.scheduler.onDue(loopId, h.now(), false);
		if (due.action !== "dispatch") throw new Error("expected dispatch");
		const settled = h.scheduler.onTickSettled({
			loopId,
			deliveryId: due.tick.deliveryId,
			outcome: "retrying",
		});
		expect(settled.action).toBe("in_progress");
		expect(loopEntry(h, loopId).phase).toBe("running");
	});
});

describe("onUserAbort", () => {
	it("pauses the loop and never consumes keepalive credit", () => {
		const h = harness();
		const created = createDynamicLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;
		h.scheduler.onScheduleWakeup({
			loopId,
			delaySeconds: 600,
			requestedDelaySeconds: 600,
			reason: "poll",
			prompt: "/loop watch the queue",
			noop: false,
		});
		h.advance(600_000);
		const due = h.scheduler.onDue(loopId, h.now(), false);
		if (due.action !== "dispatch") throw new Error("expected dispatch");

		const aborted = h.scheduler.onUserAbort(loopId);
		expect(aborted.action).toBe("paused");
		const entry = expectDynamic(loopEntry(h, loopId));
		expect(entry.phase).toBe("suspended");
		expect(entry.phase).not.toBe("ended");
		expect(entry.keepaliveCredit).toBe(1);
		expect(h.timers.armed.has(loopId)).toBe(false);

		// The aborted turn settles afterwards; that omission must NOT be treated as keepalive.
		const after = h.scheduler.onTurnEndedWithoutSchedule(loopId);
		expect(after.action).toBe("ignored");
		expect(expectDynamic(loopEntry(h, loopId)).keepaliveCredit).toBe(1);
		expect(loopEntry(h, loopId).phase).toBe("suspended");
	});
});

describe("pause, resume, stop", () => {
	it("pauses and resumes a single loop, recomputing the next fire from now", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		const paused = h.scheduler.pause(loopId);
		expect(paused.affectedLoopIds).toEqual([loopId]);
		expect(loopEntry(h, loopId).phase).toBe("suspended");
		expect(h.timers.armed.has(loopId)).toBe(false);

		// Idempotent: a second pause changes nothing and reports no newly affected loop.
		expect(h.scheduler.pause(loopId).affectedLoopIds).toEqual([]);
		expect(loopEntry(h, loopId).phase).toBe("suspended");

		h.advance(DAY);
		const resumed = h.scheduler.resume(loopId);
		expect(resumed.affectedLoopIds).toEqual([loopId]);
		expect(loopEntry(h, loopId).phase).toBe("waiting");
		expect(expectFixed(loopEntry(h, loopId)).nextFireAt).toBe(h.now() + 5 * MINUTE);
		expect(h.timers.dueAt(loopId)).toBe(h.now() + 5 * MINUTE);
		expect(h.scheduler.resume(loopId).affectedLoopIds).toEqual([]);
	});

	it("pauses and resumes all loops", () => {
		const h = harness();
		const a = createFixedLoop(h, { prompt: "a" });
		const b = createFixedLoop(h, { prompt: "b" });
		if (!a.ok || !b.ok) throw new Error("create failed");

		expect(sorted(h.scheduler.pause("all").affectedLoopIds)).toEqual([a.loopId, b.loopId].sort());
		expect(loopEntry(h, a.loopId).phase).toBe("suspended");
		expect(loopEntry(h, b.loopId).phase).toBe("suspended");
		expect(h.timers.armed.size).toBe(0);

		expect(sorted(h.scheduler.resume("all").affectedLoopIds)).toEqual([a.loopId, b.loopId].sort());
		expect(h.timers.armed.size).toBe(2);
	});

	it("stops a single loop and all loops, idempotently, without resurrecting an ended loop", () => {
		const h = harness();
		const a = createFixedLoop(h, { prompt: "a" });
		const b = createFixedLoop(h, { prompt: "b" });
		const c = createDynamicLoop(h, "c");
		if (!a.ok || !b.ok || !c.ok) throw new Error("create failed");

		const stopped = h.scheduler.stop(a.loopId, "user-command");
		expect(stopped.affectedLoopIds).toEqual([a.loopId]);
		expect(loopEntry(h, a.loopId).endReason).toBe("stopped");
		expect(loopEntry(h, a.loopId).endDetail).toBe("user-command");
		expect(h.scheduler.stop(a.loopId, "user-command").affectedLoopIds).toEqual([]);

		const stoppedAll = h.scheduler.stop("all", "user-command");
		expect(sorted(stoppedAll.affectedLoopIds)).toEqual([b.loopId, c.loopId].sort());
		expect(h.timers.armed.size).toBe(0);
		expect(h.scheduler.getState().activeDynamicId).toBeNull();

		// A stopped loop cannot be resumed back into an armed state.
		expect(h.scheduler.resume("all").affectedLoopIds).toEqual([]);
		expect(loopEntry(h, b.loopId).phase).toBe("ended");
		expect(h.timers.armed.size).toBe(0);
	});

	it("cancels the timer on stop, and a stale due callback dispatches nothing", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		h.scheduler.stop(loopId, "user-command");
		expect(h.timers.cancelLog).toContain(loopId);

		// Defense in depth: even if a port leaked a stale callback, the due decision is
		// re-derived from state and must refuse to dispatch.
		h.advance(5 * MINUTE);
		expect(h.scheduler.onDue(loopId, h.now(), false).action).toBe("coalesce");
		expect(loopEntry(h, loopId).tickCount).toBe(0);
		expect(h.scheduler.currentDeliveryId(loopId)).toBeUndefined();
	});

	it("refuses to dispatch a due tick for a paused loop", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		h.scheduler.pause(created.loopId);
		h.advance(5 * MINUTE);
		expect(h.scheduler.onDue(created.loopId, h.now(), false).action).toBe("coalesce");
		expect(loopEntry(h, created.loopId).tickCount).toBe(0);
	});
});

describe("onShutdown and restore", () => {
	it("suspends every loop with no terminal reason and cancels every timer", () => {
		const h = harness();
		const a = createFixedLoop(h, { prompt: "a" });
		const b = createDynamicLoop(h, "b");
		if (!a.ok || !b.ok) throw new Error("create failed");
		h.scheduler.onScheduleWakeup({
			loopId: b.loopId,
			delaySeconds: 600,
			requestedDelaySeconds: 600,
			reason: "poll",
			prompt: "/loop b",
			noop: false,
		});

		const result = h.scheduler.onShutdown();
		expect(sorted(result.suspendedLoopIds)).toEqual([a.loopId, b.loopId].sort());
		for (const id of [a.loopId, b.loopId]) {
			const entry = loopEntry(h, id);
			expect(entry.phase).toBe("suspended");
			expect(entry.endReason).toBeUndefined();
			expect(entry.endedAt).toBeUndefined();
		}
		expect(h.timers.cancelAllCount).toBeGreaterThan(0);
		expect(h.timers.armed.size).toBe(0);
	});

	it("re-arms on restore and emits at most one recovery tick per overdue job", () => {
		const h = harness();
		const overdue = createFixedLoop(h, { prompt: "overdue" });
		const future = createFixedLoop(h, { intervalMs: 2 * HOUR, prompt: "future" });
		if (!overdue.ok || !future.ok) throw new Error("create failed");
		h.scheduler.onShutdown();

		h.advance(DAY);
		const restored = h.scheduler.restore(h.now());
		expect(restored.recoveryTicks.map((tick) => tick.loopId)).toEqual([overdue.loopId, future.loopId]);
		expect(restored.recoveryTicks.filter((tick) => tick.loopId === overdue.loopId)).toHaveLength(1);

		expect(expectFixed(loopEntry(h, overdue.loopId)).nextFireAt).toBe(h.now() + 5 * MINUTE);
		expect(expectFixed(loopEntry(h, future.loopId)).nextFireAt).toBe(h.now() + 2 * HOUR);
		expect(h.timers.dueAt(overdue.loopId)).toBe(h.now() + 5 * MINUTE);
	});

	it("converts a crashed running tick into exactly one coalesced recovery tick", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		h.advance(5 * MINUTE);
		const due = h.scheduler.onDue(loopId, h.now(), false);
		expect(due.action).toBe("dispatch");
		expect(loopEntry(h, loopId).phase).toBe("running");
		h.advance(5 * MINUTE);
		expect(h.scheduler.onDue(loopId, h.now(), false).action).toBe("coalesce");
		expect(expectFixed(loopEntry(h, loopId)).coalescedFirePending).toBe(true);

		// Crash: the process dies with no shutdown hook, so a NEW scheduler starts from the
		// persisted state and must turn that queued/running remnant into ONE recovery tick.
		const crashed = h.scheduler.getState();
		const next = harness({
			now: h.now() + MINUTE,
			initialState: crashed,
			idPrefix: "restored-",
		});
		const restored = next.scheduler.restore(next.now());
		expect(restored.recoveryTicks.filter((tick) => tick.loopId === loopId)).toHaveLength(1);
		expect(expectFixed(loopEntry(next, loopId)).coalescedFirePending).toBe(false);
		expect(expectFixed(loopEntry(next, loopId)).nextFireAt).toBe(next.now() + 5 * MINUTE);
		expect(next.timers.dueAt(loopId)).toBe(next.now() + 5 * MINUTE);
	});

	it("restores an overdue dynamic wakeup exactly once and drops the pending wakeup", () => {
		const h = harness();
		const created = createDynamicLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;
		h.scheduler.onScheduleWakeup({
			loopId,
			delaySeconds: 600,
			requestedDelaySeconds: 600,
			reason: "poll",
			prompt: "/loop watch the queue",
			noop: false,
		});
		h.scheduler.onShutdown();

		h.advance(2 * HOUR);
		const restored = h.scheduler.restore(h.now());
		expect(restored.recoveryTicks.map((tick) => tick.loopId)).toEqual([loopId]);
		expect(expectDynamic(loopEntry(h, loopId)).pendingWakeup).toBeNull();

		// Settle that recovery delivery, then restore again: the one-shot wakeup was
		// consumed, so nothing may be replayed.
		h.scheduler.onTickSettled({
			loopId,
			deliveryId: restored.recoveryTicks[0]!.deliveryId,
			outcome: "completed",
		});
		const again = h.scheduler.restore(h.now());
		expect(again.recoveryTicks).toHaveLength(0);
		expect(loopEntry(h, loopId).tickCount).toBe(1);
	});

	it("keeps an explicitly user-paused loop paused across restore", () => {
		const h = harness();
		const paused = createFixedLoop(h, { prompt: "paused" });
		const running = createFixedLoop(h, { prompt: "running" });
		if (!paused.ok || !running.ok) throw new Error("create failed");
		h.scheduler.pause(paused.loopId);
		h.scheduler.onShutdown();

		h.advance(DAY);
		const restored = h.scheduler.restore(h.now(), { userPausedLoopIds: [paused.loopId] });

		expect(restored.stillPausedLoopIds).toEqual([paused.loopId]);
		expect(loopEntry(h, paused.loopId).phase).toBe("suspended");
		expect(h.timers.armed.has(paused.loopId)).toBe(false);
		expect(restored.recoveryTicks.map((tick) => tick.loopId)).toEqual([running.loopId]);

		// The shutdown-suspended loop, by contrast, is re-armed.
		expect(loopEntry(h, running.loopId).phase).toBe("queued");
		expect(h.timers.dueAt(running.loopId)).toBe(h.now() + 5 * MINUTE);
	});

	it("leaves a stopped loop ended across restore", () => {
		const h = harness();
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		h.scheduler.stop(created.loopId, "user-command");
		h.scheduler.onShutdown();

		h.advance(DAY);
		const restored = h.scheduler.restore(h.now());
		expect(restored.recoveryTicks).toHaveLength(0);
		expect(loopEntry(h, created.loopId).phase).toBe("ended");
		expect(h.timers.armed.size).toBe(0);
	});
});

describe("max-ticks budget", () => {
	it("ends the loop with tick_budget_exhausted and arms no further timer", () => {
		const h = harness({ env: { SENPI_LOOP_MAX_TICKS: "2" } });
		const created = createFixedLoop(h);
		if (!created.ok) throw new Error("create failed");
		const loopId = created.loopId;

		h.advance(5 * MINUTE);
		expect(h.scheduler.onDue(loopId, h.now(), false).action).toBe("dispatch");
		runTickSettleFromRunning(h, loopId);
		expect(loopEntry(h, loopId).phase).toBe("waiting");

		h.advance(5 * MINUTE);
		const second = h.scheduler.onDue(loopId, h.now(), false);
		expect(second.action).toBe("dispatch");
		expect(loopEntry(h, loopId).tickCount).toBe(2);
		runTickSettleFromRunning(h, loopId);

		const ended = loopEntry(h, loopId);
		expect(ended.phase).toBe("ended");
		expect(ended.endReason).toBe("tick_budget_exhausted");
		expect(h.timers.armed.has(loopId)).toBe(false);

		h.advance(5 * MINUTE);
		expect(h.scheduler.onDue(loopId, h.now(), false).action).toBe("coalesce");
		expect(loopEntry(h, loopId).tickCount).toBe(2);
	});

	it("defaults to 2000 ticks and rejects a sub-1 override", () => {
		expect(DEFAULT_MAX_TICKS).toBe(2000);
		const h = harness({ env: { SENPI_LOOP_MAX_TICKS: "0" } });
		expect(h.scheduler.maxTicks).toBe(1);
		const bad = harness({ env: { SENPI_LOOP_MAX_TICKS: "not-a-number" } });
		expect(bad.scheduler.maxTicks).toBe(DEFAULT_MAX_TICKS);
	});
});

/** Settles the currently running tick of a loop using its last dispatched delivery id. */
function runTickSettleFromRunning(h: Harness, loopId: string): void {
	const deliveryId = h.scheduler.currentDeliveryId(loopId);
	if (deliveryId === undefined) throw new Error("no running delivery");
	h.scheduler.onTickSettled({ loopId, deliveryId, outcome: "completed" });
}

describe("terminal reasons", () => {
	it("never produces a session_closed reason from any transition", () => {
		const observed = new Set<LoopEndReason>();

		const stopHarness = harness();
		const stopped = createFixedLoop(stopHarness, { prompt: "stopped" });
		if (!stopped.ok) throw new Error("create failed");
		stopHarness.scheduler.stop(stopped.loopId, "user-command");
		observed.add(requireEndReason(loopEntry(stopHarness, stopped.loopId)));

		const budgetHarness = harness({ env: { SENPI_LOOP_MAX_TICKS: "1" } });
		const budget = createFixedLoop(budgetHarness, { prompt: "budget" });
		if (!budget.ok) throw new Error("create failed");
		budgetHarness.advance(5 * MINUTE);
		budgetHarness.scheduler.onDue(budget.loopId, budgetHarness.now(), false);
		runTickSettleFromRunning(budgetHarness, budget.loopId);
		observed.add(requireEndReason(loopEntry(budgetHarness, budget.loopId)));

		const keepaliveHarness = harness();
		const keepalive = createDynamicLoop(keepaliveHarness, "keepalive");
		if (!keepalive.ok) throw new Error("create failed");
		keepaliveHarness.scheduler.onTurnEndedWithoutSchedule(keepalive.loopId);
		keepaliveHarness.advance(DEFAULT_KEEPALIVE_SECONDS * 1000);
		runTick(keepaliveHarness, keepalive.loopId);
		keepaliveHarness.scheduler.onTurnEndedWithoutSchedule(keepalive.loopId);
		observed.add(requireEndReason(loopEntry(keepaliveHarness, keepalive.loopId)));

		const expiryHarness = harness();
		const expiring = createFixedLoop(expiryHarness, { prompt: "expiring" });
		if (!expiring.ok) throw new Error("create failed");
		expiryHarness.setNow(expiryHarness.now() + LOOP_EXPIRY_MS);
		expiryHarness.scheduler.onDue(expiring.loopId, expiryHarness.now(), false);
		observed.add(requireEndReason(loopEntry(expiryHarness, expiring.loopId)));

		expect([...observed].sort()).toEqual(["expired", "keepalive_exhausted", "stopped", "tick_budget_exhausted"]);
		for (const reason of observed) {
			// Exhaustive switch: adding session_closed to LoopEndReason would fail typecheck here.
			const label: string = ((value: LoopEndReason): string => {
				switch (value) {
					case "stopped":
						return "stopped";
					case "keepalive_exhausted":
						return "keepalive_exhausted";
					case "expired":
						return "expired";
					case "tick_budget_exhausted":
						return "tick_budget_exhausted";
					case "error":
						return "error";
				}
			})(reason);
			expect(label).not.toBe("session_closed");
		}
	});
});

function sorted(ids: readonly string[]): string[] {
	return [...ids].sort();
}

function requireEndReason(entry: CronEntry): LoopEndReason {
	if (entry.phase !== "ended") throw new Error(`loop ${entry.id} is ${entry.phase}, expected ended`);
	return entry.endReason;
}
