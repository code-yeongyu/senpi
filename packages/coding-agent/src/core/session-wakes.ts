/**
 * The durable wakes a session's loop keeps for it when the loop runs away from this machine (a hosted loop, senpi#6754).
 * A tool that schedules work (`schedule_prompt`, `schedule_wakeup`) arms one here instead of a timer or a job file on
 * this machine; the loop turns it into its own durable wake.
 *
 * A wake carries the schedule and what to run, never key material: when it comes due while no device is online to grant
 * the session key, the loop keeps it pending until one does. It is never dropped and never runs keyless.
 */

/** Which tool armed the wake; the loop may present them differently. */
export type SessionWakeSource = "schedule_prompt" | "schedule_wakeup";

export interface SessionWake {
	/** Stable per wake: arming the same id again replaces it. */
	readonly id: string;
	readonly source: SessionWakeSource;
	/** When it is due, epoch ms. */
	readonly dueAt: number;
	/** Recurrence period in ms; absent for a one-shot wake. */
	readonly everyMs?: number;
	/** The prompt the loop delivers to the session when the wake fires. */
	readonly prompt: string;
	/** When the wake was first armed, epoch ms (a scheduled prompt's delivery header names it). */
	readonly createdAt: number;
}

/** What a call did to the loop's wakes, in order. */
export type SessionWakeChange = { readonly op: "arm"; readonly wake: SessionWake } | { readonly op: "cancel"; readonly id: string };

/** A session's wakes as its loop keeps them: the pending ones, and the changes a call makes to them. */
export interface SessionWakePort {
	pending(): readonly SessionWake[];
	arm(wake: SessionWake): void;
	/** Cancels a pending wake; `false` when none has the id. */
	cancel(id: string): boolean;
}
