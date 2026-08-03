import { describe, expect, it, vi } from "vitest";
import { type ProbeBackEvent, ProbeBackScheduler } from "../../src/core/retry-fallback/probe-scheduler.ts";

// Controllable timer harness: captures setTimeout callbacks so tests can fire
// them deterministically without real waits.
interface TimerEntry {
	callback: () => void;
	delay: number;
	id: number;
	fired: boolean;
}

function createTimerHarness() {
	let nextId = 1;
	const timers = new Map<number, TimerEntry>();

	const fakeSetTimeout = (callback: () => void, delay: number): unknown => {
		const id = nextId++;
		timers.set(id, { callback, delay, id, fired: false });
		return id;
	};

	const fakeClearTimeout = (handle: unknown): void => {
		if (typeof handle !== "number") throw new Error("Unexpected timer handle");
		timers.delete(handle);
	};

	return {
		setTimeout: fakeSetTimeout,
		clearTimeout: fakeClearTimeout,
		/** Fire the first pending (un-fired, non-cleared) timer. */
		fireFirst(): void {
			for (const entry of timers.values()) {
				if (!entry.fired) {
					entry.fired = true;
					timers.delete(entry.id);
					entry.callback();
					return;
				}
			}
			throw new Error("No pending timer to fire");
		},
		/** Count pending (non-fired, non-cleared) timers. */
		pendingCount(): number {
			let count = 0;
			for (const entry of timers.values()) {
				if (!entry.fired) count++;
			}
			return count;
		},
	};
}

function createCapture() {
	const events: ProbeBackEvent[] = [];
	const runProbeCalls: AbortSignal[] = [];
	return {
		events,
		runProbeCalls,
		emit(event: ProbeBackEvent): void {
			events.push(event);
		},
	};
}

function defaultInput(
	capture: ReturnType<typeof createCapture>,
	opts: {
		selector?: string;
		firstAtMs?: number;
		deadlineMs?: number;
		authAvailable?: () => boolean;
		runProbe?: (signal: AbortSignal) => Promise<boolean>;
		onCleared?: (selector: string) => void;
	},
) {
	const onClearedCalls: string[] = [];
	const userRunProbe = opts.runProbe;
	return {
		onClearedCalls,
		input: {
			selector: opts.selector ?? "faux/faux-1",
			firstAtMs: opts.firstAtMs ?? 500,
			deadlineMs: opts.deadlineMs ?? 1000,
			authAvailable: opts.authAvailable ?? (() => true),
			runProbe: async (signal: AbortSignal) => {
				capture.runProbeCalls.push(signal);
				return userRunProbe ? userRunProbe(signal) : false;
			},
			onCleared:
				opts.onCleared ??
				((selector: string) => {
					onClearedCalls.push(selector);
				}),
			emit: capture.emit,
		},
	};
}

describe("ProbeBackScheduler", () => {
	// (1) arm -> first probe fires, failure -> second at deadline, failure ->
	// exactly 2 runProbe calls, result ok:false emitted.
	it("fires two probes on consecutive failures and emits ok:false", async () => {
		const now = 0;
		const th = createTimerHarness();
		const capture = createCapture();
		const { input } = defaultInput(capture, { firstAtMs: 500, deadlineMs: 1000 });

		const scheduler = new ProbeBackScheduler({
			now: () => now,
			setTimeout: th.setTimeout,
			clearTimeout: th.clearTimeout,
		});

		expect(scheduler.active).toBe(false);
		scheduler.arm(input);
		expect(scheduler.active).toBe(true);

		// Probe 1 scheduled event emitted.
		expect(capture.events).toContainEqual({
			type: "retry_probe_scheduled",
			selector: "faux/faux-1",
			atMs: 500,
			probeIndex: 1,
		});

		// Fire first timer -> probe 1 runs (returns false).
		th.fireFirst();
		// Wait for the async runProbe to settle.
		await vi.waitFor(() => expect(capture.runProbeCalls.length).toBe(1));

		// Probe 2 scheduled event emitted.
		expect(capture.events).toContainEqual({
			type: "retry_probe_scheduled",
			selector: "faux/faux-1",
			atMs: 1000,
			probeIndex: 2,
		});

		// Fire second timer -> probe 2 runs (returns false).
		th.fireFirst();
		await vi.waitFor(() => expect(capture.runProbeCalls.length).toBe(2));

		// Final result: ok:false, exactly 2 probes.
		expect(capture.events).toContainEqual({
			type: "retry_probe_result",
			selector: "faux/faux-1",
			ok: false,
		});
		expect(capture.runProbeCalls.length).toBe(2);
		expect(scheduler.active).toBe(false);
	});

	// (2) First probe success -> onCleared called, ok:true emitted, NO second probe.
	it("clears cooldown and emits ok:true on first probe success", async () => {
		const now = 0;
		const th = createTimerHarness();
		const capture = createCapture();
		const { input, onClearedCalls } = defaultInput(capture, {
			firstAtMs: 500,
			deadlineMs: 1000,
			runProbe: async () => true, // succeeds
		});

		const scheduler = new ProbeBackScheduler({
			now: () => now,
			setTimeout: th.setTimeout,
			clearTimeout: th.clearTimeout,
		});

		scheduler.arm(input);
		expect(th.pendingCount()).toBe(2);

		th.fireFirst();
		await vi.waitFor(() => expect(capture.events.some((e) => e.type === "retry_probe_result" && e.ok)).toBe(true));

		expect(onClearedCalls).toEqual(["faux/faux-1"]);
		expect(capture.events).toContainEqual({
			type: "retry_probe_result",
			selector: "faux/faux-1",
			ok: true,
		});

		// No second probe scheduled.
		expect(capture.events.filter((e) => e.type === "retry_probe_scheduled")).toHaveLength(1);
		expect(capture.runProbeCalls.length).toBe(1);
		expect(th.pendingCount()).toBe(0);
		expect(scheduler.active).toBe(false);
	});

	// (3) cancel("dispose") mid-wait -> zero probes fire.
	it("cancel prevents all probe execution when called before first timer fires", async () => {
		const now = 0;
		const th = createTimerHarness();
		const capture = createCapture();
		const { input } = defaultInput(capture, { firstAtMs: 500, deadlineMs: 1000 });

		const scheduler = new ProbeBackScheduler({
			now: () => now,
			setTimeout: th.setTimeout,
			clearTimeout: th.clearTimeout,
		});

		scheduler.arm(input);
		expect(th.pendingCount()).toBe(2);

		// Cancel before any timer fires.
		scheduler.cancel("dispose");

		expect(scheduler.active).toBe(false);
		expect(th.pendingCount()).toBe(0);
		expect(capture.runProbeCalls.length).toBe(0);

		// The scheduled event was emitted at arm time, but NO result event.
		expect(capture.events.filter((e) => e.type === "retry_probe_result")).toEqual([]);
	});

	// (4) arm while armed supersedes (old timers never fire).
	it("second arm supersedes the first; old timers never fire", async () => {
		const now = 0;
		const th = createTimerHarness();
		const capture = createCapture();
		const { input: input1 } = defaultInput(capture, {
			selector: "faux/faux-1",
			firstAtMs: 500,
			deadlineMs: 1000,
		});
		const { input: input2, onClearedCalls: onCleared2 } = defaultInput(capture, {
			selector: "faux/faux-2",
			firstAtMs: 300,
			deadlineMs: 600,
			runProbe: async () => true,
		});

		const scheduler = new ProbeBackScheduler({
			now: () => now,
			setTimeout: th.setTimeout,
			clearTimeout: th.clearTimeout,
		});

		scheduler.arm(input1);
		expect(th.pendingCount()).toBe(2);

		// Supersede with a second arm.
		scheduler.arm(input2);
		expect(scheduler.active).toBe(true);
		expect(th.pendingCount()).toBe(2); // only the new arm's timers

		// Fire the new timer -> probe for faux-2 runs, succeeds.
		th.fireFirst();
		await vi.waitFor(() => expect(onCleared2.length).toBe(1));

		expect(onCleared2).toEqual(["faux/faux-2"]);
		expect(capture.runProbeCalls.length).toBe(1); // only one probe ran (the second arm's)

		// No result event for faux-1.
		expect(capture.events.filter((e) => e.type === "retry_probe_result" && e.selector === "faux/faux-1")).toEqual([]);
		expect(scheduler.active).toBe(false);
	});

	// (5) Auth unavailable at firstAtMs -> ok:false auth-unavailable, disarm.
	it("emits auth-unavailable result when auth is not available at probe time", async () => {
		const now = 0;
		let authOk = true;
		const th = createTimerHarness();
		const capture = createCapture();
		const { input } = defaultInput(capture, {
			firstAtMs: 500,
			deadlineMs: 1000,
			authAvailable: () => authOk,
		});

		const scheduler = new ProbeBackScheduler({
			now: () => now,
			setTimeout: th.setTimeout,
			clearTimeout: th.clearTimeout,
		});

		scheduler.arm(input);

		// Auth becomes unavailable before the first probe fires.
		authOk = false;

		th.fireFirst();
		await vi.waitFor(() => expect(capture.events.some((e) => e.type === "retry_probe_result")).toBe(true));

		expect(capture.events).toContainEqual({
			type: "retry_probe_result",
			selector: "faux/faux-1",
			ok: false,
			errorMessage: "auth-unavailable",
		});
		expect(capture.runProbeCalls.length).toBe(0); // probe body never ran
		expect(th.pendingCount()).toBe(0); // no second timer scheduled
		expect(scheduler.active).toBe(false);
	});

	// (6) cancel mid-in-flight probe: probe result after cancel must not clear cooldown.
	it("stale probe result after cancel does not call onCleared", async () => {
		const now = 0;
		const th = createTimerHarness();
		const capture = createCapture();
		let resolveProbe: ((value: boolean) => void) | undefined;
		const onClearedCalls: string[] = [];
		const input = {
			selector: "faux/faux-1",
			firstAtMs: 500,
			deadlineMs: 1000,
			authAvailable: () => true,
			runProbe: (_signal: AbortSignal) => {
				capture.runProbeCalls.push(_signal);
				return new Promise<boolean>((resolve) => {
					resolveProbe = resolve;
				});
			},
			onCleared: (selector: string) => {
				onClearedCalls.push(selector);
			},
			emit: capture.emit,
		};

		const scheduler = new ProbeBackScheduler({
			now: () => now,
			setTimeout: th.setTimeout,
			clearTimeout: th.clearTimeout,
		});

		scheduler.arm(input);

		// Fire first timer -> probe starts (hangs on resolveProbe).
		th.fireFirst();
		await vi.waitFor(() => expect(capture.runProbeCalls.length).toBe(1));

		// Cancel while probe is in-flight. Both timers are cleared and the probe is aborted.
		scheduler.cancel("dispose");
		expect(capture.runProbeCalls[0]?.aborted).toBe(true);
		expect(th.pendingCount()).toBe(0);

		// Now resolve the probe as success — but scheduler is disarmed, onCleared must NOT fire.
		resolveProbe?.(true);

		// Give the microtask a tick to settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(onClearedCalls).toEqual([]);
		expect(capture.events.filter((e) => e.type === "retry_probe_result")).toEqual([]);
		expect(scheduler.active).toBe(false);
	});

	it("arm during in-flight probe swallows the old result and preserves cancellation", async () => {
		const now = 0;
		const th = createTimerHarness();
		const capture = createCapture();
		let resolveOldProbe: ((value: boolean) => void) | undefined;
		let resolveNewProbe: ((value: boolean) => void) | undefined;
		const { input: oldInput, onClearedCalls: oldOnClearedCalls } = defaultInput(capture, {
			selector: "faux/faux-1",
			runProbe: () =>
				new Promise<boolean>((resolve) => {
					resolveOldProbe = resolve;
				}),
		});
		const { input: newInput } = defaultInput(capture, {
			selector: "faux/faux-2",
			firstAtMs: 300,
			deadlineMs: 600,
			runProbe: () =>
				new Promise<boolean>((resolve) => {
					resolveNewProbe = resolve;
				}),
		});
		const scheduler = new ProbeBackScheduler({
			now: () => now,
			setTimeout: th.setTimeout,
			clearTimeout: th.clearTimeout,
		});

		scheduler.arm(oldInput);
		th.fireFirst();
		await vi.waitFor(() => expect(capture.runProbeCalls).toHaveLength(1));

		scheduler.arm(newInput);
		resolveOldProbe?.(true);
		await Promise.resolve();
		await Promise.resolve();

		expect(oldOnClearedCalls).toEqual([]);
		expect(capture.events.filter((event) => event.type === "retry_probe_result")).toEqual([]);
		expect(scheduler.active).toBe(true);
		expect(th.pendingCount()).toBe(2);

		th.fireFirst();
		await vi.waitFor(() => expect(capture.runProbeCalls).toHaveLength(2));
		resolveNewProbe?.(false);
		await Promise.resolve();
		await Promise.resolve();
		expect(capture.events).toContainEqual({
			type: "retry_probe_scheduled",
			selector: "faux/faux-2",
			atMs: 600,
			probeIndex: 2,
		});
		expect(th.pendingCount()).toBe(1);

		scheduler.cancel("dispose");
		expect(th.pendingCount()).toBe(0);
		expect(capture.runProbeCalls).toHaveLength(2);
	});

	it("aborts a hanging first probe at the deadline and runs the final probe", async () => {
		const th = createTimerHarness();
		const capture = createCapture();
		let attempt = 0;
		let resolveCleared: ((selector: string) => void) | undefined;
		const cleared = new Promise<string>((resolve) => {
			resolveCleared = resolve;
		});
		const { input } = defaultInput(capture, {
			runProbe: (signal) => {
				attempt++;
				if (attempt === 1) return new Promise<boolean>(() => undefined);
				return Promise.resolve(!signal.aborted);
			},
			onCleared: (selector) => resolveCleared?.(selector),
		});
		const scheduler = new ProbeBackScheduler({
			now: () => 0,
			setTimeout: th.setTimeout,
			clearTimeout: th.clearTimeout,
		});

		scheduler.arm(input);
		expect(th.pendingCount()).toBe(2);
		th.fireFirst();
		expect(capture.runProbeCalls).toHaveLength(1);
		expect(capture.runProbeCalls[0]?.aborted).toBe(false);

		th.fireFirst();
		expect(capture.runProbeCalls[0]?.aborted).toBe(true);
		expect(capture.runProbeCalls).toHaveLength(2);
		await expect(cleared).resolves.toBe("faux/faux-1");

		expect(capture.events).toContainEqual({
			type: "retry_probe_result",
			selector: "faux/faux-1",
			ok: true,
		});
		expect(scheduler.active).toBe(false);
		expect(th.pendingCount()).toBe(0);
	});

	// (7) Second probe (at deadline) succeeds -> onCleared + ok:true.
	it("second probe at deadline succeeds and clears cooldown", async () => {
		const now = 0;
		let probeAttempt = 0;
		const th = createTimerHarness();
		const capture = createCapture();
		const onClearedCalls: string[] = [];
		const input = {
			selector: "faux/faux-1",
			firstAtMs: 500,
			deadlineMs: 1000,
			authAvailable: () => true,
			runProbe: async (_signal: AbortSignal) => {
				capture.runProbeCalls.push(_signal);
				probeAttempt++;
				return probeAttempt === 2; // fail first, succeed second
			},
			onCleared: (selector: string) => {
				onClearedCalls.push(selector);
			},
			emit: capture.emit,
		};

		const scheduler = new ProbeBackScheduler({
			now: () => now,
			setTimeout: th.setTimeout,
			clearTimeout: th.clearTimeout,
		});

		scheduler.arm(input);

		// Probe 1: failure.
		th.fireFirst();
		await vi.waitFor(() => expect(capture.runProbeCalls.length).toBe(1));
		expect(th.pendingCount()).toBe(1); // deadline timer scheduled

		// Probe 2: success.
		th.fireFirst();
		await vi.waitFor(() => expect(onClearedCalls.length).toBe(1));

		expect(onClearedCalls).toEqual(["faux/faux-1"]);
		expect(capture.events).toContainEqual({
			type: "retry_probe_result",
			selector: "faux/faux-1",
			ok: true,
		});
		expect(capture.runProbeCalls.length).toBe(2);
		expect(scheduler.active).toBe(false);
	});
});
