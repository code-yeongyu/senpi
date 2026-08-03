/**
 * Bounded probe-back scheduler for tier-2 demoted selectors.
 *
 * Owns ONE armed probe plan per session: at most two probes (first at half-hint,
 * then at the absolute deadline), never two in-flight simultaneously. Arming
 * while armed silently supersedes the previous plan. cancel() aborts any
 * in-flight probe and clears pending timers — no further emits after cancel.
 *
 * All timers go through the injected `setTimeout`/`clearTimeout` pair so tests
 * can drive them deterministically with fake timers.
 */

export interface ProbeBackArmInput {
	selector: string;
	firstAtMs: number;
	deadlineMs: number;
	authAvailable: () => boolean;
	runProbe: (signal: AbortSignal) => Promise<boolean>;
	onCleared: (selector: string) => void;
	emit: (event: ProbeBackEvent) => void;
}

export type ProbeBackEvent =
	| { type: "retry_probe_scheduled"; selector: string; atMs: number; probeIndex: 1 | 2 }
	| { type: "retry_probe_result"; selector: string; ok: boolean; errorMessage?: string };

export type ProbeBackCancelReason = "manual-model-change" | "dispose" | "superseded";

interface ScheduledTimer {
	handle: unknown;
}

export class ProbeBackScheduler {
	private readonly _now: () => number;
	private readonly _setTimeout: (callback: () => void, delay: number) => unknown;
	private readonly _clearTimeout: (handle: unknown) => void;

	private _armed = false;
	private _generation = 0;
	private _firstTimer: ScheduledTimer | undefined;
	private _deadlineTimer: ScheduledTimer | undefined;
	private _abortController: AbortController | undefined;
	private _activeProbeIndex: 1 | 2 | undefined;
	private _secondProbeAnnounced = false;

	constructor(opts: {
		now: () => number;
		setTimeout?: (callback: () => void, delay: number) => unknown;
		clearTimeout?: (handle: unknown) => void;
	}) {
		this._now = opts.now;
		this._setTimeout = opts.setTimeout ?? ((cb, d) => setTimeout(cb, d));
		// boundary narrowing: injected handle type
		this._clearTimeout = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	get active(): boolean {
		return this._armed;
	}

	arm(input: ProbeBackArmInput): void {
		const gen = ++this._generation;
		// Supersede any existing plan silently.
		if (this._armed) {
			this._clearTimers();
			this._abortInFlight("superseded");
			this._disarm();
		}

		this._armed = true;
		this._firstTimer = { handle: undefined };
		this._deadlineTimer = { handle: undefined };
		this._activeProbeIndex = undefined;
		this._secondProbeAnnounced = false;

		// Emit scheduled event for probe 1.
		if (gen !== this._generation) return;
		input.emit({
			type: "retry_probe_scheduled",
			selector: input.selector,
			atMs: input.firstAtMs,
			probeIndex: 1,
		});
		if (gen !== this._generation) return;

		const firstDelay = Math.max(0, input.firstAtMs - this._now());
		if (this._firstTimer) {
			this._firstTimer.handle = this._setTimeout(() => {
				void this._runProbe(input, 1, gen);
			}, firstDelay);
		}

		const deadlineDelay = Math.max(0, input.deadlineMs - this._now());
		if (gen !== this._generation) return;
		if (this._deadlineTimer) {
			this._deadlineTimer.handle = this._setTimeout(() => {
				this._runDeadlineProbe(input, gen);
			}, deadlineDelay);
		}
	}

	cancel(reason: ProbeBackCancelReason): void {
		this._generation++;
		this._clearTimers();
		this._abortInFlight(reason);
		this._disarm();
	}

	private _clearTimers(): void {
		if (this._firstTimer?.handle !== undefined) {
			this._clearTimeout(this._firstTimer.handle);
			this._firstTimer.handle = undefined;
		}
		if (this._deadlineTimer?.handle !== undefined) {
			this._clearTimeout(this._deadlineTimer.handle);
			this._deadlineTimer.handle = undefined;
		}
	}

	private _abortInFlight(_reason: ProbeBackCancelReason): void {
		if (this._abortController) {
			this._abortController.abort();
			this._abortController = undefined;
		}
		this._activeProbeIndex = undefined;
	}

	private _disarm(): void {
		this._armed = false;
		this._firstTimer = undefined;
		this._deadlineTimer = undefined;
		this._abortController = undefined;
		this._activeProbeIndex = undefined;
		this._secondProbeAnnounced = false;
	}

	private _finish(): void {
		this._clearTimers();
		this._disarm();
	}

	private _announceSecondProbe(input: ProbeBackArmInput, generation: number): void {
		if (generation !== this._generation || this._secondProbeAnnounced) return;
		this._secondProbeAnnounced = true;
		input.emit({
			type: "retry_probe_scheduled",
			selector: input.selector,
			atMs: input.deadlineMs,
			probeIndex: 2,
		});
	}

	private _runDeadlineProbe(input: ProbeBackArmInput, generation: number): void {
		if (generation !== this._generation || !this._armed) return;
		if (this._deadlineTimer) this._deadlineTimer.handle = undefined;
		if (this._firstTimer?.handle !== undefined) {
			this._clearTimeout(this._firstTimer.handle);
			this._firstTimer.handle = undefined;
		}
		if (this._activeProbeIndex === 1) this._abortInFlight("superseded");
		this._announceSecondProbe(input, generation);
		if (generation !== this._generation) return;
		void this._runProbe(input, 2, generation);
	}

	private async _runProbe(input: ProbeBackArmInput, probeIndex: 1 | 2, generation: number): Promise<void> {
		const gen = generation;
		if (gen !== this._generation || !this._armed) return;

		// Clear the timer that just fired so cancel doesn't try to clear a stale handle.
		if (probeIndex === 1 && this._firstTimer) {
			this._firstTimer.handle = undefined;
		} else if (this._deadlineTimer) {
			this._deadlineTimer.handle = undefined;
		}

		// Guard: auth unavailable -> fail immediately, disarm.
		if (!input.authAvailable()) {
			if (gen !== this._generation) return;
			input.emit({
				type: "retry_probe_result",
				selector: input.selector,
				ok: false,
				errorMessage: "auth-unavailable",
			});
			if (gen !== this._generation) return;
			this._finish();
			return;
		}

		// Set up abort controller for the in-flight probe.
		if (gen !== this._generation || this._activeProbeIndex !== undefined) return;
		const abortController = new AbortController();
		this._abortController = abortController;
		this._activeProbeIndex = probeIndex;

		let success: boolean;
		try {
			success = await input.runProbe(abortController.signal);
		} catch {
			success = false;
		}

		if (
			gen !== this._generation ||
			this._activeProbeIndex !== probeIndex ||
			this._abortController !== abortController
		) {
			return;
		}
		this._abortController = undefined;
		this._activeProbeIndex = undefined;

		if (success) {
			if (gen !== this._generation) return;
			input.onCleared(input.selector);
			if (gen !== this._generation) return;
			input.emit({
				type: "retry_probe_result",
				selector: input.selector,
				ok: true,
			});
			if (gen !== this._generation) return;
			this._finish();
			return;
		}

		// First probe failed — the already-armed deadline timer owns the final attempt.
		if (probeIndex === 1) {
			this._announceSecondProbe(input, gen);
			return;
		}

		// Second probe failed — final result, disarm.
		if (gen !== this._generation) return;
		input.emit({
			type: "retry_probe_result",
			selector: input.selector,
			ok: false,
		});
		if (gen !== this._generation) return;
		this._finish();
	}
}
