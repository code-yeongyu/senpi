/**
 * senpi#7572, no hang: whether a run that asked for a designated answerer has one connected, as its session's UI sees
 * it. While none is, a new ask is refused at once (the permission system reads `capabilities.answerer` at ask time).
 * A prompt already raised when the last answerer leaves is settled after `ANSWERER_GRACE_MS`, so an answerer that
 * reattaches with its key in time still answers it; a run nobody can answer never waits forever.
 */

/** How long a raised prompt waits for its run's answerer to come back before it is settled as unanswerable. */
export const ANSWERER_GRACE_MS = 30_000;

/** Starts a timer and returns its cancel; a test passes a virtual clock here. */
export type Schedule = (run: () => void, ms: number) => () => void;

const realSchedule: Schedule = (run, ms) => {
	const timer = setTimeout(run, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
};

export class AnswererPresence {
	private absent = false;
	private cancelGrace: (() => void) | undefined;
	/** Settles every prompt the run is waiting on; called once per absence that outlasts the grace. */
	private readonly settleRaised: () => void;
	private readonly schedule: Schedule;
	private readonly graceMs: number;

	constructor(settleRaised: () => void, schedule: Schedule = realSchedule, graceMs = ANSWERER_GRACE_MS) {
		this.settleRaised = settleRaised;
		this.schedule = schedule;
		this.graceMs = graceMs;
	}

	/** The value `ExtensionUIContext.capabilities.answerer` reports; undefined for a run without the rule. */
	answerer(): "absent" | undefined {
		return this.absent ? "absent" : undefined;
	}

	/** The router's view changed: `present` is whether one of the run's answerers is attached now. */
	set(present: boolean): void {
		if (present) {
			this.absent = false;
			this.cancelGrace?.();
			this.cancelGrace = undefined;
			return;
		}
		if (this.absent) return;
		this.absent = true;
		this.cancelGrace = this.schedule(() => {
			this.cancelGrace = undefined;
			if (this.absent) this.settleRaised();
		}, this.graceMs);
	}

	dispose(): void {
		this.cancelGrace?.();
		this.cancelGrace = undefined;
	}
}
