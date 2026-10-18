// The session-level turn deadline contract: how long a turn may run with no tool
// progress, and the absolute cap on one turn's runtime. One implementation for every
// surface - TUI, RPC, and host sessions all run through AgentSession.

export const TURN_DEADLINE_ENTRY_TYPE = "deadline-stop";

export interface TurnDeadlineSettings {
	readonly inactivityMs: number;
	readonly maxRuntimeMs: number;
}

/** Milliseconds the abort is given to terminalize before the lease forces settlement. */
export const TURN_DEADLINE_GRACE_MS = 10_000;

export const DEFAULT_TURN_INACTIVITY_MS = 3_600_000;
export const MIN_TURN_INACTIVITY_MS = 60_000;
export const DEFAULT_TURN_MAX_RUNTIME_MS = 21_600_000;

export type TurnDeadlineKind = "inactivity" | "max_runtime";

export interface TurnDeadline {
	readonly kind: TurnDeadlineKind;
	readonly limitMs: number;
	readonly elapsedMs: number;
}

/**
 * The recorded form of a deadline stop, durable on the session branch so a config reload
 * or session reopen keeps suppressing goal continuations until admitted user input.
 */
export interface DeadlineStopData {
	readonly kind: TurnDeadlineKind;
	readonly limitMs: number;
	readonly elapsedMs: number;
	readonly at: number;
}

interface DeadlineStopEntry {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly message?: { readonly role?: string };
}

function isDeadlineStopData(data: unknown): data is DeadlineStopData {
	if (data === null || typeof data !== "object") return false;
	const candidate = data as Partial<DeadlineStopData>;
	return (
		(candidate.kind === "inactivity" || candidate.kind === "max_runtime") &&
		typeof candidate.limitMs === "number" &&
		typeof candidate.elapsedMs === "number"
	);
}

/**
 * The latest deadline stop on the branch, or undefined when none is pending. A
 * deadline-stopped session suppresses every automatic continuation until admitted user
 * input starts a new turn; the entry is read fresh so the hold survives reload and reopen.
 * Only a user message releases the hold: the aborted assistant message of the stopped
 * turn is persisted after the stop entry and must not clear it.
 */
export function deadlineStopPendingSinceLastTurn(entries: readonly DeadlineStopEntry[]): DeadlineStopData | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type === "message" && entry.message?.role === "user") return undefined;
		if (entry.type === "custom" && entry.customType === TURN_DEADLINE_ENTRY_TYPE && isDeadlineStopData(entry.data)) {
			return entry.data;
		}
	}
	return undefined;
}

export function resolveTurnDeadlineSettings(configured: {
	readonly turn_inactivity_ms?: unknown;
	readonly turn_max_runtime_ms?: unknown;
}): TurnDeadlineSettings {
	const milliseconds = (value: unknown, fallback: number, minimum: number): number => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
		if (value === 0) return 0;
		return Math.max(minimum, Math.floor(value));
	};
	return {
		inactivityMs: milliseconds(configured.turn_inactivity_ms, DEFAULT_TURN_INACTIVITY_MS, MIN_TURN_INACTIVITY_MS),
		maxRuntimeMs: milliseconds(configured.turn_max_runtime_ms, DEFAULT_TURN_MAX_RUNTIME_MS, 1),
	};
}

/**
 * The narrow AgentSession surface the tracker needs, declared here so the tracker lives
 * with the rest of the deadline contract instead of inside agent-session.ts.
 */
export type TurnDeadlineWarning =
	| "turn_deadline_record_failed"
	| "turn_deadline_abort_failed"
	| "turn_deadline_unsettled"
	| "turn_deadline_failed";

export interface DeadlineSessionOwner {
	_recordDeadlineStop(deadline: TurnDeadline): void;
	/** End the turn through the normal system abort (tools see the abort signal); resolves once the session is idle. */
	abortTurnForDeadline(): Promise<void>;
	/** True while a provider retry is in flight; the engine is actively recovering the turn. */
	readonly isRetryInFlight: boolean;
	readonly isIdle: boolean;
	/** A deadline stop that could not complete (the entry write failed, or the turn outlived the grace). */
	_warnDeadline(event: TurnDeadlineWarning, detail: string): void;
}

/** Resolves true when `work` settles within `ms`, false when the time runs out first. */
async function within(work: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([
			work.then(
				() => true,
				() => false,
			),
			expired,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Owns the inactivity lease and the hard max-runtime cap for one turn. Armed at prompt
 * accept, renewed only by tool execution progress and admitted user input, never by text
 * deltas. On expiry it records the durable stop entry and ends the run through the normal
 * system-abort path. This is the single implementation of senpi#3227 for every surface.
 */
export class AgentDeadlineTracker {
	private inactivityTimer: ReturnType<typeof setTimeout> | undefined;
	private maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;
	private deadlineValue: TurnDeadline | undefined;
	private startedAtMs = 0;
	private readonly session: DeadlineSessionOwner;
	private readonly settings: () => TurnDeadlineSettings;
	private readonly now: () => number;

	get current(): TurnDeadline | undefined {
		return this.deadlineValue;
	}

	constructor(session: DeadlineSessionOwner, settings: () => TurnDeadlineSettings, now: () => number = Date.now) {
		this.session = session;
		this.settings = settings;
		this.now = now;
	}

	arm(): void {
		this.clearTimers();
		this.deadlineValue = undefined;
		this.startedAtMs = this.now();
		const { inactivityMs, maxRuntimeMs } = this.settings();
		if (inactivityMs > 0) this.inactivityTimer = setTimeout(() => this.fire("inactivity"), inactivityMs);
		if (maxRuntimeMs > 0) this.maxRuntimeTimer = setTimeout(() => this.fire("max_runtime"), maxRuntimeMs);
	}

	renew(): void {
		if (this.deadlineValue !== undefined || this.startedAtMs === 0) return;
		const { inactivityMs } = this.settings();
		if (inactivityMs <= 0) return;
		if (this.inactivityTimer !== undefined) clearTimeout(this.inactivityTimer);
		this.inactivityTimer = setTimeout(() => this.fire("inactivity"), inactivityMs);
	}

	disarm(): void {
		this.clearTimers();
		this.startedAtMs = 0;
	}

	/**
	 * Admitted user input releases the deadline-stopped hold. Input steered into a live run counts as
	 * activity (the inactivity lease restarts) but never resets the max-runtime clock of that run.
	 */
	clearHold(): void {
		// A stopped run that has not settled keeps its deadline (its agent_end reports it); the next arm resets it.
		if (this.deadlineValue === undefined) {
			this.renew();
			return;
		}
		// Once the stopped run has settled, its deadline is history: input clears it.
		if (this.session.isIdle) this.deadlineValue = undefined;
	}

	private clearTimers(): void {
		if (this.inactivityTimer !== undefined) clearTimeout(this.inactivityTimer);
		if (this.maxRuntimeTimer !== undefined) clearTimeout(this.maxRuntimeTimer);
		this.inactivityTimer = undefined;
		this.maxRuntimeTimer = undefined;
	}

	private fire(kind: TurnDeadlineKind): void {
		this.expire(kind).catch((error: unknown) =>
			this.session._warnDeadline("turn_deadline_failed", error instanceof Error ? error.message : String(error)),
		);
	}

	private async expire(kind: TurnDeadlineKind): Promise<void> {
		if (this.deadlineValue !== undefined || this.startedAtMs === 0) return;
		const { inactivityMs, maxRuntimeMs } = this.settings();
		const limitMs = kind === "inactivity" ? inactivityMs : maxRuntimeMs;
		if (limitMs <= 0) return;
		// A provider retry in flight is the engine recovering the turn: it renews the inactivity lease.
		// The max-runtime cap is absolute and applies through retries.
		if (kind === "inactivity" && this.session.isRetryInFlight) {
			this.inactivityTimer = undefined;
			this.renew();
			return;
		}
		this.clearTimers();
		const deadline: TurnDeadline = { kind, limitMs, elapsedMs: this.now() - this.startedAtMs };
		this.deadlineValue = deadline;
		try {
			this.session._recordDeadlineStop(deadline);
		} catch (error) {
			// The stop still happens; only its durable hold entry is missing.
			this.session._warnDeadline(
				"turn_deadline_record_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
		// The abort signal reaches every running tool (the bash tool kills its process tree on it), and the
		// normal settle path emits agent_idle once the run ends. A turn still running after the grace is held by
		// something no abort can end (an extension handler that never returns): it is reported, never faked idle.
		let abortError: string | undefined;
		const aborting = this.session.abortTurnForDeadline().catch((error: unknown) => {
			abortError = error instanceof Error ? error.message : String(error);
		});
		const settled = await within(aborting, TURN_DEADLINE_GRACE_MS);
		if (abortError !== undefined) this.session._warnDeadline("turn_deadline_abort_failed", abortError);
		if (settled && abortError === undefined) return;
		if (!this.session.isIdle)
			this.session._warnDeadline(
				"turn_deadline_unsettled",
				`turn still running ${TURN_DEADLINE_GRACE_MS} ms after the ${kind} deadline abort`,
			);
	}
}

export function buildDeadlineStopNotice(deadline: TurnDeadline): string {
	const limit =
		deadline.limitMs < 60_000
			? `${Math.max(1, Math.round(deadline.limitMs / 1000))} s`
			: `${Math.round(deadline.limitMs / 60_000)} min`;
	const reason =
		deadline.kind === "inactivity"
			? `no tool progress for ${limit} (turn_inactivity_ms)`
			: `turn hit its maximum runtime of ${limit} (turn_max_runtime_ms)`;
	return `turn stopped: ${reason}. Action: send a message to continue, or raise the limit in settings`;
}
