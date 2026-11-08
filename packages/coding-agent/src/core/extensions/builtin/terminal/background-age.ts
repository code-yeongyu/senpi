/**
 * Age notices of still-running background sessions (senpi#6201): one at 10 minutes, then one every 30 minutes (10, 40,
 * 70, ...). One schedule per session bundle serves every session with ONE unref'd timer armed for the earliest due
 * notice, so it never keeps the process alive and costs nothing per session; it is cleared when the last session
 * leaves and on dispose. A late timer (the machine slept) or a session registered after it started reports at most
 * once for the milestones it missed, never a burst.
 */
import type { TerminalBackgroundAgeEvent } from "../monitor-state-event.ts";

const MINUTE_MS = 60_000;
export const BACKGROUND_AGE_FIRST_MS = 10 * MINUTE_MS;
export const BACKGROUND_AGE_REPEAT_MS = 30 * MINUTE_MS;
const MAX_TIMER_MS = 2_147_483_647;

/** The first age milestone strictly after `ageMs`. */
export function nextAgeMilestoneMs(ageMs: number): number {
	if (ageMs < BACKGROUND_AGE_FIRST_MS) return BACKGROUND_AGE_FIRST_MS;
	const repeats = Math.floor((ageMs - BACKGROUND_AGE_FIRST_MS) / BACKGROUND_AGE_REPEAT_MS) + 1;
	return BACKGROUND_AGE_FIRST_MS + repeats * BACKGROUND_AGE_REPEAT_MS;
}

export interface BackgroundAgeSubject {
	readonly id: string;
	readonly description: string;
	readonly command?: string;
	readonly startedAtMs: number;
	readonly autoReapMinutes?: number;
}

export function backgroundAgeEvent(
	kind: TerminalBackgroundAgeEvent["kind"],
	subject: BackgroundAgeSubject,
	nowMs: number,
): TerminalBackgroundAgeEvent {
	const ageMs = Math.max(0, nowMs - subject.startedAtMs);
	return {
		kind,
		id: subject.id,
		description: subject.description,
		...(subject.command === undefined ? {} : { command: subject.command }),
		startedAtMs: subject.startedAtMs,
		ageMs,
		ageMinutes: Math.floor(ageMs / MINUTE_MS),
		autoReapMinutes: subject.autoReapMinutes ?? null,
		stop: { tool: "kill_bash", args: { bash_id: subject.id } },
	};
}

interface Entry {
	readonly subject: BackgroundAgeSubject;
	dueAtMs: number;
}

export class BackgroundAgeSchedule {
	readonly #entries = new Map<string, Entry>();
	readonly #onDue: (event: TerminalBackgroundAgeEvent) => void;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(onDue: (event: TerminalBackgroundAgeEvent) => void) {
		this.#onDue = onDue;
	}

	add(subject: BackgroundAgeSubject): void {
		const now = Date.now();
		this.#entries.set(subject.id, {
			subject,
			dueAtMs: subject.startedAtMs + nextAgeMilestoneMs(now - subject.startedAtMs),
		});
		this.#arm(now);
	}

	remove(id: string): BackgroundAgeSubject | undefined {
		const entry = this.#entries.get(id);
		if (!entry) return undefined;
		this.#entries.delete(id);
		this.#arm(Date.now());
		return entry.subject;
	}

	dispose(): void {
		this.#entries.clear();
		this.#clearTimer();
	}

	#fire(): void {
		this.#timer = undefined;
		const now = Date.now();
		const due: TerminalBackgroundAgeEvent[] = [];
		for (const entry of this.#entries.values()) {
			if (entry.dueAtMs > now) continue;
			const ageMs = now - entry.subject.startedAtMs;
			due.push(backgroundAgeEvent("running", entry.subject, now));
			entry.dueAtMs = entry.subject.startedAtMs + nextAgeMilestoneMs(ageMs);
		}
		this.#arm(now);
		for (const event of due) this.#onDue(event);
	}

	#arm(now: number): void {
		this.#clearTimer();
		let earliest: number | undefined;
		for (const entry of this.#entries.values()) {
			if (earliest === undefined || entry.dueAtMs < earliest) earliest = entry.dueAtMs;
		}
		if (earliest === undefined) return;
		const timer = setTimeout(() => this.#fire(), Math.min(Math.max(0, earliest - now), MAX_TIMER_MS));
		timer.unref?.();
		this.#timer = timer;
	}

	#clearTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
