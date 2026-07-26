import type { MonitorEvent } from "./monitor-registry.ts";
import { getTerminalNotificationDelivery, type TerminalNotifierDeps } from "./notify.ts";
import { sanitizeTerminalOutput } from "./output-format.ts";
import type { MonitorDeliverySettings } from "./settings.ts";

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
const QUEUE_OVERHEAD_CHARS = 512;

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
	/** Pause live monitors when their shared wake budget is exhausted. */
	readonly pauseMonitors: () => readonly string[];
	readonly scheduler?: MonitorNotificationScheduler;
}

interface Overflow {
	readonly id: string;
	count: number;
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
	};
}

function eventBody(event: MonitorEvent): string {
	const value = event.type === "line" ? event.line : event.summary;
	return sanitizeTerminalOutput(value)
		.replace(/[\r\n]+/g, " ")
		.trimEnd();
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 3)}...`;
}

function formatEvents(events: readonly MonitorEvent[]): string {
	const groups = new Map<string, { description: string; bodies: string[] }>();
	for (const event of events) {
		const group = groups.get(event.id) ?? { description: event.description, bodies: [] };
		group.bodies.push(eventBody(event));
		groups.set(event.id, group);
	}
	return [...groups.values()]
		.map((group) => `Monitor event(${group.description}): ${group.bodies.join("\n")}`)
		.join("\n");
}

/**
 * Session-scoped monitor delivery queue. It preserves the terminal runtime as the authoritative,
 * bounded event history while retaining only one capped coalescing batch for chat injection.
 */
export class MonitorNotifier {
	readonly #deps: MonitorNotifierDeps;
	readonly #scheduler: MonitorNotificationScheduler;
	#events: MonitorEvent[] = [];
	#eventChars = 0;
	#overflow = new Map<string, Overflow>();
	#lastInjectionAt = new Map<string, number>();
	#timer: unknown;
	#scheduledAt: number | undefined;
	#consecutiveWakes = 0;
	#wakeBudgetPaused = false;

	constructor(deps: MonitorNotifierDeps) {
		this.#deps = deps;
		this.#scheduler = deps.scheduler ?? systemScheduler;
	}

	notifyEvent(event: MonitorEvent): void {
		if (this.#wakeBudgetPaused) return;
		if (!getTerminalNotificationDelivery(this.#deps)) return;
		const settings = resolveSettings(this.#deps.getSettings());
		const rendered = `Monitor event(${event.description}): ${eventBody(event)}`;
		const queueLimit = Math.max(1, settings.maxCharsPerInjection - QUEUE_OVERHEAD_CHARS);
		if (this.#events.length >= settings.maxLinesPerInjection || this.#eventChars + rendered.length > queueLimit) {
			this.#recordOverflow(event.id);
		} else {
			this.#events.push(event);
			this.#eventChars += rendered.length;
		}
		this.#schedule(settings.coalesceWindowMs);
	}

	/** Any explicit user or tool activity breaks a consecutive monitor-only wake streak. */
	noteActivity(): void {
		this.#consecutiveWakes = 0;
	}

	/** Explicit rearm is the only operation that releases the session-global wake pause. */
	rearm(id: string): void {
		this.#wakeBudgetPaused = false;
		this.#consecutiveWakes = 0;
		this.#lastInjectionAt.delete(id);
	}

	dispose(): void {
		if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#scheduledAt = undefined;
		this.#events = [];
		this.#eventChars = 0;
		this.#overflow.clear();
	}

	#recordOverflow(id: string): void {
		const overflow = this.#overflow.get(id) ?? { id, count: 0 };
		overflow.count++;
		this.#overflow.set(id, overflow);
	}

	#schedule(delayMs: number): void {
		const due = this.#scheduler.now() + delayMs;
		if (this.#timer !== undefined && this.#scheduledAt !== undefined && this.#scheduledAt <= due) return;
		if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
		this.#scheduledAt = due;
		this.#timer = this.#scheduler.setTimeout(() => this.#flush(), delayMs);
	}

	#flush(): void {
		this.#timer = undefined;
		this.#scheduledAt = undefined;
		if (this.#wakeBudgetPaused) {
			this.dispose();
			return;
		}
		const delivery = getTerminalNotificationDelivery(this.#deps);
		if (!delivery) {
			this.dispose();
			return;
		}

		const settings = resolveSettings(this.#deps.getSettings());
		const now = this.#scheduler.now();
		const pendingIds = new Set([...this.#events.map((event) => event.id), ...this.#overflow.keys()]);
		if (pendingIds.size === 0) return;
		const ready = new Set(
			[...pendingIds].filter((id) => {
				const last = this.#lastInjectionAt.get(id);
				return last === undefined || now - last >= settings.rateLimitMs;
			}),
		);
		if (ready.size === 0) {
			this.#scheduleNextRateLimit(pendingIds, now, settings);
			return;
		}

		const selected = this.#events.filter((event) => ready.has(event.id));
		const deferred = this.#events.filter((event) => !ready.has(event.id));
		const overflowCount = [...this.#overflow.values()]
			.filter((overflow) => ready.has(overflow.id))
			.reduce((total, overflow) => total + overflow.count, 0);
		const reachesBudget = this.#consecutiveWakes + 1 >= settings.wakeBudget;
		const pauseNotice = reachesBudget ? "Monitor paused - peek bash_output or re-arm this monitor." : "";
		const content = this.#buildMessage(selected, overflowCount, pauseNotice, settings.maxCharsPerInjection);

		delivery.send(content);
		for (const id of ready) this.#lastInjectionAt.set(id, now);
		this.#events = deferred;
		this.#eventChars = deferred.reduce(
			(total, event) => total + `Monitor event(${event.description}): ${eventBody(event)}`.length,
			0,
		);
		for (const id of ready) this.#overflow.delete(id);
		this.#consecutiveWakes++;

		if (reachesBudget) {
			this.#wakeBudgetPaused = true;
			this.#deps.pauseMonitors();
			this.#events = [];
			this.#eventChars = 0;
			this.#overflow.clear();
			return;
		}
		const remainingIds = new Set([...this.#events.map((event) => event.id), ...this.#overflow.keys()]);
		if (remainingIds.size > 0) this.#scheduleNextRateLimit(remainingIds, now, settings);
	}

	#scheduleNextRateLimit(ids: ReadonlySet<string>, now: number, settings: MonitorDeliverySettings): void {
		const nextAt = Math.min(...[...ids].map((id) => (this.#lastInjectionAt.get(id) ?? now) + settings.rateLimitMs));
		this.#schedule(Math.max(1, nextAt - now));
	}

	#buildMessage(
		events: readonly MonitorEvent[],
		overflowCount: number,
		pauseNotice: string,
		maxChars: number,
	): string {
		const overflowNotice =
			overflowCount > 0
				? `[${overflowCount} additional event lines omitted; peek bash_output for full history.]`
				: "";
		const suffix = [overflowNotice, pauseNotice].filter(Boolean).join("\n");
		const fixedChars = SYSTEM_REMINDER_OPEN.length + SYSTEM_REMINDER_CLOSE.length + (suffix ? suffix.length + 1 : 0);
		const body = clip(formatEvents(events), Math.max(0, maxChars - fixedChars));
		return `${SYSTEM_REMINDER_OPEN}${body}${body && suffix ? "\n" : ""}${suffix}${SYSTEM_REMINDER_CLOSE}`;
	}
}
