import { vi } from "vitest";
import {
	type MonitorNotificationScheduler,
	MonitorNotifier,
} from "../../src/core/extensions/builtin/terminal/monitor-notify.ts";
import type { MonitorEvent } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";

export type SentMessage = {
	readonly message: {
		readonly customType: string;
		readonly content: string;
		readonly display: boolean;
	};
	readonly options:
		| {
				readonly triggerTurn?: boolean;
				readonly deliverAs?: "steer" | "followUp";
		  }
		| undefined;
};

type ScheduledTask = { readonly at: number; readonly callback: () => void; cancelled: boolean };

export class FakeScheduler implements MonitorNotificationScheduler {
	#now = 0;
	#tasks: ScheduledTask[] = [];

	now(): number {
		return this.#now;
	}

	setTimeout(callback: () => void, delayMs: number): ScheduledTask {
		const task: ScheduledTask = { at: this.#now + delayMs, callback, cancelled: false };
		this.#tasks.push(task);
		return task;
	}

	clearTimeout(task: ScheduledTask): void {
		task.cancelled = true;
	}

	advanceBy(ms: number): void {
		const deadline = this.#now + ms;
		for (;;) {
			const task = this.#tasks
				.filter((candidate) => !candidate.cancelled && candidate.at <= deadline)
				.sort((left, right) => left.at - right.at)[0];
			if (!task) break;
			this.#tasks = this.#tasks.filter((candidate) => candidate !== task);
			this.#now = task.at;
			task.callback();
		}
		this.#now = deadline;
	}
}

export function line(id: string, description: string, value: string): MonitorEvent {
	return { type: "line", id, description, line: value };
}

export function summary(id: string, description: string, value: string): MonitorEvent {
	return { type: "summary", id, description, summary: value };
}

export function createNotifier(
	overrides: {
		mode?: "wake" | "next-turn" | "off";
		ctxMode?: string;
		hasModel?: boolean;
		settings?: Partial<{
			coalesceWindowMs: number;
			rateLimitMs: number;
			maxLinesPerInjection: number;
			maxCharsPerInjection: number;
			wakeBudget: number;
		}>;
	} = {},
) {
	const scheduler = new FakeScheduler();
	const sent: SentMessage[] = [];
	const pauseMonitors = vi.fn(() => ["bash_budget"]);
	const notifier = new MonitorNotifier({
		sendMessage: (message, options) => sent.push({ message, options }),
		getContext: () =>
			({
				mode: overrides.ctxMode ?? "tui",
				model: overrides.hasModel === false ? undefined : { id: "mock", api: "openai-completions" },
			}) as never,
		getMode: () => overrides.mode ?? "wake",
		getSettings: () => ({
			coalesceWindowMs: 2000,
			rateLimitMs: 5000,
			maxLinesPerInjection: 50,
			maxCharsPerInjection: 4096,
			wakeBudget: 5,
			...overrides.settings,
		}),
		pauseMonitors,
		scheduler,
	});
	return { notifier, pauseMonitors, scheduler, sent };
}
