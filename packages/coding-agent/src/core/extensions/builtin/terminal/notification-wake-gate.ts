import { isHumanInputMonitorNotification, MONITOR_NOTIFICATION_CUSTOM_TYPE } from "../monitor-state-event.ts";
import type { MonitorNotificationScheduler } from "./monitor-notify.ts";
import type { TerminalNotifierDeps } from "./notify.ts";

type SendMessage = TerminalNotifierDeps["sendMessage"];
type NotificationMessage = Parameters<SendMessage>[0];
type NotificationOptions = Parameters<SendMessage>[1];
interface HeldNotification {
	readonly message: NotificationMessage;
	readonly options: NotificationOptions;
}

/** Consecutive turns without a tool call after which notification wakes back off. */
export const IDLE_WAKE_TURN_THRESHOLD = 2;
/** Backoff after the threshold is reached; it doubles with each further idle turn. */
export const IDLE_WAKE_BASE_DELAY_MS = 30_000;
/** Backoff ceiling: the default pace of a persistent monitor (12 wakes an hour). */
export const IDLE_WAKE_MAX_DELAY_MS = 300_000;

const systemScheduler: MonitorNotificationScheduler = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Session-scoped backoff for monitor and terminal notification wakes.
 *
 * A notification that would start a turn while the session is idle is a wake. Once the session's
 * last `IDLE_WAKE_TURN_THRESHOLD` turns ended without a tool call, the next wake waits
 * `IDLE_WAKE_BASE_DELAY_MS` after the last turn ended, doubling per further idle turn up to
 * `IDLE_WAKE_MAX_DELAY_MS`. Notifications that arrive meanwhile join the held wake, which is sent as
 * ONE message; a turn that starts for any other reason takes them as steers. Nothing is dropped,
 * and a tool call or person input ends the backoff. A monitor delivery that carries a person's words
 * (`human_input`) is person input: it is never held and sends any held notifications with it.
 */
export class NotificationWakeGate {
	readonly #send: SendMessage;
	readonly #scheduler: MonitorNotificationScheduler;
	#held: HeldNotification[] = [];
	#timer: unknown;
	#idleTurns = 0;
	#turnRunning = false;
	#toolCalledThisTurn = false;
	#lastTurnEndAt: number | undefined;

	constructor(send: SendMessage, scheduler: MonitorNotificationScheduler = systemScheduler) {
		this.#send = send;
		this.#scheduler = scheduler;
	}

	readonly sendMessage: SendMessage = (message, options) => {
		if (options.triggerTurn !== true || this.#turnRunning) {
			this.#send(message, options);
			return;
		}
		if (isHumanInputMonitorNotification({ role: "custom", ...message })) {
			this.#idleTurns = 0;
			this.#held.push({ message, options });
			this.#clearTimer();
			this.#flush();
			return;
		}
		if (this.#held.length > 0) {
			this.#held.push({ message, options });
			return;
		}
		const now = this.#scheduler.now();
		const delayMs = this.#lastTurnEndAt === undefined ? 0 : this.#lastTurnEndAt + this.backoffMs() - now;
		if (delayMs <= 0) {
			this.#send(message, options);
			return;
		}
		this.#held.push({ message, options });
		this.#timer = this.#scheduler.setTimeout(() => this.#flush(), delayMs);
	};

	/** Current wake backoff; 0 until the idle-turn threshold is reached. */
	backoffMs(): number {
		if (this.#idleTurns < IDLE_WAKE_TURN_THRESHOLD) return 0;
		return Math.min(
			IDLE_WAKE_MAX_DELAY_MS,
			IDLE_WAKE_BASE_DELAY_MS * 2 ** (this.#idleTurns - IDLE_WAKE_TURN_THRESHOLD),
		);
	}

	noteTurnStart(): void {
		this.#turnRunning = true;
		this.#toolCalledThisTurn = false;
		this.#release();
	}

	noteToolCall(): void {
		this.#toolCalledThisTurn = true;
		this.#idleTurns = 0;
	}

	noteTurnEnd(): void {
		this.#turnRunning = false;
		this.#lastTurnEndAt = this.#scheduler.now();
		if (!this.#toolCalledThisTurn) this.#idleTurns++;
	}

	noteUserInput(): void {
		this.#idleTurns = 0;
	}

	dispose(): void {
		this.#clearTimer();
		this.#held = [];
	}

	#clearTimer(): void {
		if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** A turn started for another reason: held notifications steer into it instead of waking later. */
	#release(): void {
		this.#clearTimer();
		const held = this.#held;
		this.#held = [];
		for (const { message, options } of held) this.#send(message, { ...options, deliverAs: "steer" });
	}

	#flush(): void {
		this.#timer = undefined;
		const held = this.#held;
		this.#held = [];
		if (held.length === 0) return;
		const merged = mergeHeld(held);
		this.#send(merged.message, merged.options);
	}
}

function monitorsOf(details: unknown): readonly unknown[] | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const monitors = (details as { monitors?: unknown }).monitors;
	return Array.isArray(monitors) ? monitors : undefined;
}

function mergeHeld(held: readonly HeldNotification[]): HeldNotification {
	const [first] = held;
	if (held.length === 1 && first) return first;
	const monitors = held.flatMap(({ message }) => monitorsOf(message.details) ?? []);
	const customType = held.some(({ message }) => message.customType === MONITOR_NOTIFICATION_CUSTOM_TYPE)
		? MONITOR_NOTIFICATION_CUSTOM_TYPE
		: (first?.message.customType ?? MONITOR_NOTIFICATION_CUSTOM_TYPE);
	return {
		message: {
			customType,
			content: held.map(({ message }) => message.content).join("\n\n"),
			display: held.some(({ message }) => message.display),
			...(monitors.length > 0 ? { details: { monitors } } : {}),
		},
		options: {
			triggerTurn: true,
			deliverAs: held.some(({ options }) => options.deliverAs === "steer") ? "steer" : "followUp",
		},
	};
}
