import { describe, expect, it, vi } from "vitest";
import {
	formatLoopStatus,
	formatNoopFold,
	LOOP_STATUS_KEY,
	type LoopStatusRender,
	LoopStatusTicker,
} from "../../src/core/extensions/builtin/loop/status.ts";
import type {
	CronEntry,
	DynamicCronEntry,
	FixedCronEntry,
	LoopState,
	PendingWakeup,
} from "../../src/core/extensions/builtin/loop/types.ts";

function makeFixed(loopId: string, nextFireAt: number, phase: FixedCronEntry["phase"] = "waiting"): CronEntry {
	return {
		id: loopId,
		kind: "fixed",
		phase,
		originalArgs: "5m check",
		reentryPrompt: "/loop 5m check",
		payload: { type: "prompt", prompt: "check" },
		createdAt: 0,
		lastFiredAt: null,
		expiresAt: 1_000_000_000_000,
		lastScheduledForAt: null,
		coalescedFirePending: false,
		queuedForAt: null,
		noopStreak: 0,
		tickCount: 0,
		sentinelDelivery: {
			autonomousPreambleDelivered: false,
			lastLoopFileDelivered: null,
			forceFullDelivery: false,
		},
		wakeSources: [],
		requestedInterval: { value: 5, unit: "m", raw: "5m" },
		effectiveInterval: { value: 5, unit: "m", human: "5 minutes", rounded: false },
		cronExpression: "*/5 * * * *",
		nextFireAt,
		intervalMs: 300_000,
	} as FixedCronEntry;
}

function makeDynamic(
	loopId: string,
	pendingWakeup: PendingWakeup | null,
	phase: DynamicCronEntry["phase"] = "waiting",
): CronEntry {
	return {
		id: loopId,
		kind: "dynamic",
		phase,
		originalArgs: "check",
		reentryPrompt: "/loop check",
		payload: { type: "prompt", prompt: "check" },
		createdAt: 0,
		lastFiredAt: null,
		expiresAt: 1_000_000_000_000,
		lastScheduledForAt: null,
		coalescedFirePending: false,
		queuedForAt: null,
		noopStreak: 0,
		tickCount: 0,
		sentinelDelivery: {
			autonomousPreambleDelivered: false,
			lastLoopFileDelivered: null,
			forceFullDelivery: false,
		},
		wakeSources: [],
		pendingWakeup,
		keepaliveCredit: 1,
	} as DynamicCronEntry;
}

function makeWakeup(loopId: string, dueAt: number): PendingWakeup {
	return {
		id: "wakeup-1",
		loopId,
		kind: "dynamic",
		source: "model",
		requestedDelaySeconds: 300,
		delaySeconds: 300,
		dueAt,
		reason: "continue",
		prompt: "/loop check",
		noop: false,
		createdAt: 0,
	};
}

function stateWith(entries: CronEntry[]): LoopState {
	const record: Record<string, CronEntry> = {};
	let activeDynamicId: string | null = null;
	for (const entry of entries) {
		record[entry.id] = entry;
		if (entry.kind === "dynamic" && entry.phase !== "ended") {
			activeDynamicId = entry.id;
		}
	}
	return { version: 1, sessionId: "test", entries: record, activeDynamicId, updatedAt: 0 };
}

describe("formatLoopStatus", () => {
	it("returns undefined when nothing is armed", () => {
		const state = stateWith([{ ...makeFixed("a", 60_000), phase: "ended", endedAt: 100, endReason: "stopped" }]);
		expect(formatLoopStatus(state, 0)).toBeUndefined();
	});

	it("renders an armed fixed loop with a countdown", () => {
		const state = stateWith([makeFixed("a", 60_000)]);
		expect(formatLoopStatus(state, 0)).toMatch(/fixed/);
		expect(formatLoopStatus(state, 0)).toMatch(/next in/);
		expect(formatLoopStatus(state, 0)).toMatch(/\/loop stop/);
	});

	it("countdown decreases as the fake clock advances", () => {
		const state = stateWith([makeFixed("a", 300_000)]);
		const atStart = formatLoopStatus(state, 0)!;
		const atHalf = formatLoopStatus(state, 150_000)!;
		expect(parseInt(atStart.match(/(\d+)m/)?.[1] ?? "0", 10)).toBeGreaterThan(
			parseInt(atHalf.match(/(\d+)m/)?.[1] ?? "0", 10),
		);
	});

	it("renders a dynamic pending wakeup countdown", () => {
		const state = stateWith([makeDynamic("d", makeWakeup("d", 120_000))]);
		const text = formatLoopStatus(state, 0);
		expect(text).toMatch(/dynamic/);
		expect(text).toMatch(/next in/);
		expect(text).toMatch(/\/loop stop/);
	});

	it("renders the paused marker when the armed loop is suspended", () => {
		const state = stateWith([makeFixed("a", 60_000, "suspended")]);
		const text = formatLoopStatus(state, 0);
		expect(text).toMatch(/paused/i);
		expect(text).toMatch(/\/loop resume/);
		expect(text).toMatch(/\/loop stop/);
	});
});

describe("formatNoopFold", () => {
	it("renders nothing for a streak of 0", () => {
		expect(formatNoopFold(0)).toBe("");
	});

	it("renders a streak of 3", () => {
		expect(formatNoopFold(3)).toMatch(/3/);
		expect(formatNoopFold(3)).toMatch(/no actionable change/);
	});
});

describe("LoopStatusTicker", () => {
	it("calls the injected setStatus-shaped render callback on sync and on interval", () => {
		vi.useFakeTimers();
		try {
			const render = vi.fn<LoopStatusRender>();
			let nowMs = 0;
			const ticker = new LoopStatusTicker({ render, now: () => nowMs });
			const state = stateWith([makeFixed("a", 60_000)]);

			ticker.sync(state);
			expect(render).toHaveBeenCalledWith(LOOP_STATUS_KEY, expect.stringMatching(/\/loop stop/));
			const callsAfterSync = render.mock.calls.length;

			nowMs += 2_000;
			vi.advanceTimersByTime(2_000);
			expect(render.mock.calls.length).toBeGreaterThan(callsAfterSync);
		} finally {
			vi.useRealTimers();
		}
	});

	it("dispose() stops further renders with zero callback invocations afterwards", () => {
		vi.useFakeTimers();
		try {
			const render = vi.fn<LoopStatusRender>();
			let nowMs = 0;
			const ticker = new LoopStatusTicker({ render, now: () => nowMs });
			const state = stateWith([makeFixed("a", 60_000)]);

			ticker.sync(state);
			const callsAfterSync = render.mock.calls.length;
			expect(callsAfterSync).toBeGreaterThan(0);

			nowMs += 2_000;
			vi.advanceTimersByTime(2_000);
			const callsAfterAdvance = render.mock.calls.length;
			expect(callsAfterAdvance).toBeGreaterThan(callsAfterSync);

			ticker.dispose();
			const callsAfterDispose = render.mock.calls.length;

			nowMs += 5_000;
			vi.advanceTimersByTime(5_000);
			expect(render.mock.calls.length).toBe(callsAfterDispose);
		} finally {
			vi.useRealTimers();
		}
	});
});
