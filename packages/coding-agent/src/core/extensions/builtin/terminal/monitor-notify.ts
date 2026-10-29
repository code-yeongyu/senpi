import { MONITOR_NOTIFICATION_CUSTOM_TYPE } from "../monitor-state-event.ts";
import { withTerminalContext } from "./context-lifetime.ts";
import { monitorDetails } from "./monitor-notify-details.ts";
import { buildWakeMessage, eventBody, renderedLength, WAKE_BUDGET_PAUSE_NOTICE } from "./monitor-notify-format.ts";
import { type MonitorSpill, OverflowBook } from "./monitor-overflow.ts";
import type { MonitorEvent } from "./monitor-registry.ts";
import { fitWake } from "./monitor-wake-fit.ts";
import { WakePacer } from "./monitor-wake-pacing.ts";
import { getTerminalNotificationDelivery, type TerminalNotifierDeps } from "./notify.ts";
import type { MonitorDeliverySettings } from "./settings.ts";
import { RUNAWAY_PAUSE_SUMMARY_PREFIX } from "./shared.ts";

export type { MonitorSpill, MonitorSpillResult } from "./monitor-overflow.ts";

const QUEUE_OVERHEAD_CHARS = 512;
const WAKE_STREAK_QUIET_GAP_MULTIPLIER = 2;

export interface MonitorNotificationScheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}

const systemScheduler: MonitorNotificationScheduler = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface MonitorNotifierDeps extends TerminalNotifierDeps {
	readonly getSettings: () => MonitorDeliverySettings;
	/** Pause the monitors contributing to a shared wake-budget exhaustion. */
	readonly pauseMonitors: (ids: readonly string[]) => readonly string[];
	/** Wake rate (and burst) of a paced monitor; undefined leaves the monitor unpaced. */
	readonly wakesPerHour?: (id: string) => number | undefined;
	/** Append overflow lines to the monitor's overflow file; undefined when it has none. */
	readonly spillOverflow?: MonitorSpill;
	readonly scheduler?: MonitorNotificationScheduler;
}

function boundedPositiveInt(value: number, fallback: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function resolveSettings(settings: MonitorDeliverySettings): MonitorDeliverySettings {
	return {
		coalesceWindowMs: boundedPositiveInt(settings.coalesceWindowMs, 2000, 1, 60_000),
		rateLimitMs: boundedPositiveInt(settings.rateLimitMs, 5000, 1, 3_600_000),
		maxLinesPerInjection: boundedPositiveInt(settings.maxLinesPerInjection, 50, 1, 200),
		maxCharsPerInjection: boundedPositiveInt(settings.maxCharsPerInjection, 4096, 512, 16_384),
		wakeBudget: boundedPositiveInt(settings.wakeBudget, 5, 1, 100),
		wakesPerHour: boundedPositiveInt(settings.wakesPerHour, 12, 1, 3600),
	};
}

/**
 * Session-scoped monitor delivery queue. It preserves the terminal runtime as the authoritative,
 * bounded event history while retaining only capped per-monitor batches for chat injection. A
 * wake is filled by whole monitors; a monitor that does not fit stays queued for the next wake.
 */
export class MonitorNotifier {
	readonly #deps: MonitorNotifierDeps;
	readonly #scheduler: MonitorNotificationScheduler;
	readonly #pacer: WakePacer;
	readonly #overflow: OverflowBook;
	#events: MonitorEvent[] = [];
	#lastInjectionAt = new Map<string, number>();
	#lastInjectedBatch = new Map<string, string>();
	#timer: unknown;
	#scheduledAt: number | undefined;
	#consecutiveWakes = 0;
	#lastWakeAt: number | undefined;

	constructor(deps: MonitorNotifierDeps) {
		this.#deps = deps;
		this.#scheduler = deps.scheduler ?? systemScheduler;
		this.#pacer = new WakePacer((id) => deps.wakesPerHour?.(id));
		this.#overflow = new OverflowBook(deps.spillOverflow);
	}

	notifyEvent(event: MonitorEvent): void {
		if (event.type === "summary") {
			this.#lastInjectionAt.delete(event.id);
			this.#lastInjectedBatch.delete(event.id);
		}
		const delivery = withTerminalContext(
			() => getTerminalNotificationDelivery(this.#deps, MONITOR_NOTIFICATION_CUSTOM_TYPE),
			() => this.dispose(),
		);
		if (!delivery) return;
		const settings = resolveSettings(this.#deps.getSettings());
		const queueLimit = Math.max(1, settings.maxCharsPerInjection - QUEUE_OVERHEAD_CHARS);
		const own = this.#events.filter((queued) => queued.id === event.id);
		const ownChars = own.reduce((total, queued) => total + renderedLength(queued), 0);
		if (
			event.type !== "summary" &&
			(own.length >= settings.maxLinesPerInjection ||
				ownChars + renderedLength(event) > queueLimit ||
				this.#overflow.count(event.id) > 0)
		) {
			this.#overflow.record(event, eventBody(event));
		} else {
			this.#events.push(event);
		}
		// A paced monitor out of tokens is not flushed before its next token: no wasted wake-ups.
		const now = this.#scheduler.now();
		const delay =
			event.type === "summary"
				? settings.coalesceWindowMs
				: Math.max(settings.coalesceWindowMs, this.#pacer.readyAt(event.id, now) - now);
		this.#schedule(delay);
	}

	/** Any explicit user or tool activity breaks a consecutive monitor-only wake streak. */
	noteActivity(): void {
		this.#consecutiveWakes = 0;
	}

	/** Clear delivery bookkeeping for monitors explicitly resumed by the registry. */
	resume(ids: readonly string[]): void {
		for (const id of ids) {
			this.#lastInjectionAt.delete(id);
			this.#lastInjectedBatch.delete(id);
		}
		this.#consecutiveWakes = 0;
	}

	rearm(id: string): void {
		this.resume([id]);
	}

	dispose(): void {
		if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#scheduledAt = undefined;
		this.#events = [];
		this.#overflow.clear();
		this.#lastInjectedBatch.clear();
		this.#pacer.clear();
	}

	#schedule(delayMs: number): void {
		const due = this.#scheduler.now() + delayMs;
		if (this.#timer !== undefined && this.#scheduledAt !== undefined && this.#scheduledAt <= due) return;
		if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
		this.#scheduledAt = due;
		this.#timer = this.#scheduler.setTimeout(
			() =>
				withTerminalContext(
					() => this.#flush(),
					() => this.dispose(),
				),
			delayMs,
		);
	}

	#pendingIds(): Set<string> {
		return new Set([...this.#events.map((event) => event.id), ...this.#overflow.ids()]);
	}

	#flush(): void {
		this.#timer = undefined;
		this.#scheduledAt = undefined;
		const delivery = getTerminalNotificationDelivery(this.#deps, MONITOR_NOTIFICATION_CUSTOM_TYPE);
		if (!delivery) {
			this.dispose();
			return;
		}

		const settings = resolveSettings(this.#deps.getSettings());
		const now = this.#scheduler.now();
		const pendingIds = this.#pendingIds();
		if (pendingIds.size === 0) return;
		const summaryIds = new Set(this.#events.filter((event) => event.type === "summary").map((event) => event.id));
		const ready = [...pendingIds].filter((id) => {
			if (summaryIds.has(id)) return true;
			const last = this.#lastInjectionAt.get(id);
			if (last !== undefined && now - last < settings.rateLimitMs) return false;
			return this.#pacer.readyAt(id, now) <= now;
		});
		if (ready.length === 0) {
			this.#scheduleNext(pendingIds, now, settings);
			return;
		}

		const fingerprints = this.#batchFingerprints(ready);
		const suppressedIds = new Set(
			[...fingerprints]
				.filter(([id, fingerprint]) => this.#lastInjectedBatch.get(id) === fingerprint)
				.map(([id]) => id),
		);
		this.#events = this.#events.filter((event) => !suppressedIds.has(event.id));
		const wake = fitWake(
			this.#events,
			this.#overflow,
			ready.filter((id) => !suppressedIds.has(id)),
			summaryIds,
			settings.maxCharsPerInjection,
		);
		if (wake.size === 0) {
			this.#scheduleNext(this.#pendingIds(), now, settings);
			return;
		}
		const injectedIds = new Set(wake.keys());
		const selected = [...wake.values()].flatMap((share) => share.events);
		const delivered = new Set(selected);
		if (
			this.#lastWakeAt !== undefined &&
			now - this.#lastWakeAt > settings.rateLimitMs * WAKE_STREAK_QUIET_GAP_MULTIPLIER
		) {
			this.#consecutiveWakes = 0;
		}
		const deliversSummary = selected.some(
			// A runaway-guard pause summary is a pause, not a completion: exempting it keeps the
			// session-global wake streak — the notifier's own pause state — from being cleared.
			(event) => event.type === "summary" && !event.summary.startsWith(RUNAWAY_PAUSE_SUMMARY_PREFIX),
		);
		const reachesBudget = !deliversSummary && this.#consecutiveWakes + 1 >= settings.wakeBudget;
		const notices = [...wake].map(([id, share]) => (share.whole ? this.#overflow.notice(id) : ""));
		const content = buildWakeMessage(
			selected,
			notices,
			reachesBudget ? WAKE_BUDGET_PAUSE_NOTICE : "",
			settings.maxCharsPerInjection,
		);
		const details = { monitors: monitorDetails(selected, injectedIds, this.#overflow) };
		delivery.send(content, reachesBudget ? { forceWake: true, details } : { details });
		this.#lastWakeAt = now;
		for (const [id, share] of wake) {
			if (share.events.some((event) => event.type === "summary")) this.#pacer.forget(id);
			else this.#pacer.spend(id, now);
			this.#lastInjectionAt.set(id, now);
			// A monitor that sent only a prefix keeps its remaining lines and overflow for the next wake.
			if (share.whole) this.#overflow.delete(id);
			const fingerprint = share.whole ? fingerprints.get(id) : undefined;
			if (fingerprint === undefined) this.#lastInjectedBatch.delete(id);
			else this.#lastInjectedBatch.set(id, fingerprint);
		}
		this.#events = this.#events.filter((event) => !delivered.has(event));
		this.#consecutiveWakes = deliversSummary ? 0 : this.#consecutiveWakes + 1;
		if (reachesBudget) {
			// Only the monitors in this wake are paused; every other monitor keeps its held lines.
			this.#deps.pauseMonitors([...injectedIds]);
			this.#consecutiveWakes = 0;
		}
		const remainingIds = this.#pendingIds();
		if (remainingIds.size > 0) this.#scheduleNext(remainingIds, now, settings);
	}

	#scheduleNext(ids: ReadonlySet<string>, now: number, settings: MonitorDeliverySettings): void {
		const nextAt = Math.min(
			...[...ids].map((id) =>
				Math.max((this.#lastInjectionAt.get(id) ?? now) + settings.rateLimitMs, this.#pacer.readyAt(id, now)),
			),
		);
		this.#schedule(Math.max(1, nextAt - now));
	}

	/** A ready monitor whose line-only batch matches its previous injection carries no new information. */
	#batchFingerprints(ids: readonly string[]): Map<string, string> {
		const fingerprints = new Map<string, string>();
		for (const id of ids) {
			if (this.#overflow.count(id) > 0) continue;
			const batch = this.#events.filter((event) => event.id === id);
			if (batch.length === 0 || batch.some((event) => event.type !== "line")) continue;
			fingerprints.set(id, batch.map(eventBody).join("\n"));
		}
		return fingerprints;
	}
}
