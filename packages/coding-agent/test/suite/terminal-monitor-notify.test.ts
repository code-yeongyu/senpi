import { describe, expect, it, vi } from "vitest";
import {
	type MonitorNotificationScheduler,
	MonitorNotifier,
} from "../../src/core/extensions/builtin/terminal/monitor-notify.ts";
import type { MonitorEvent } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { TERMINAL_PROMPT_SECTION } from "../../src/core/extensions/builtin/terminal/prompt.ts";

type SentMessage = { readonly content: string; readonly options: { deliverAs?: "steer" | "followUp" } | undefined };

type ScheduledTask = { readonly at: number; readonly callback: () => void; cancelled: boolean };

class FakeScheduler implements MonitorNotificationScheduler {
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

function line(id: string, description: string, value: string): MonitorEvent {
	return { type: "line", id, description, line: value };
}

function createNotifier(
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
		sendUserMessage: (content, options) => sent.push({ content, options }),
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

describe("terminal monitor event delivery", () => {
	it("coalesces a burst into one wake containing each event line", () => {
		const { notifier, scheduler, sent } = createNotifier();
		for (let index = 1; index <= 10; index++) notifier.notifyEvent(line("bash_1", "build", `line-${index}`));

		scheduler.advanceBy(2000);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toContain("Monitor event(build): line-1\nline-2");
		expect(sent[0]?.content).toContain("line-10");
		expect(sent[0]?.options).toEqual({ deliverAs: "steer" });
	});

	it("queues monitor events as a follow-up in next-turn mode", () => {
		const { notifier, scheduler, sent } = createNotifier({ mode: "next-turn" });
		notifier.notifyEvent(line("bash_next", "next", "queued"));
		scheduler.advanceBy(2000);
		expect(sent[0]?.options).toEqual({ deliverAs: "followUp" });
	});

	it("enforces the per-monitor rate limit while retaining an overflow event for the next wake", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent(line("bash_rate", "rate", "first"));
		scheduler.advanceBy(2000);
		notifier.notifyEvent(line("bash_rate", "rate", "second"));
		scheduler.advanceBy(2000);
		expect(sent).toHaveLength(1);

		scheduler.advanceBy(3000);
		expect(sent).toHaveLength(2);
		expect(sent[1]?.content).toContain("second");
	});

	it("coalesces monitors that fire in the same wake window", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent(line("bash_a", "compile", "READY"));
		notifier.notifyEvent(line("bash_b", "logs", "ERROR"));
		scheduler.advanceBy(2000);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toContain("Monitor event(compile): READY");
		expect(sent[0]?.content).toContain("Monitor event(logs): ERROR");
	});

	it("caps a wake at 50 lines and 4KB, summarizing overflow that remains peekable", () => {
		const { notifier, scheduler, sent } = createNotifier();
		for (let index = 1; index <= 52; index++) notifier.notifyEvent(line("bash_cap", "cap", `event-${index}`));
		scheduler.advanceBy(2000);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toContain("event-50");
		expect(sent[0]?.content).toContain("2 additional event lines omitted; peek bash_output");
		expect(sent[0]?.content.length).toBeLessThanOrEqual(4096);

		const oversized = createNotifier();
		for (let index = 1; index <= 3; index++) {
			oversized.notifier.notifyEvent(line("bash_bytes", "bytes", "x".repeat(3000)));
		}
		oversized.scheduler.advanceBy(2000);
		expect(oversized.sent[0]?.content.length).toBeLessThanOrEqual(4096);
		expect(oversized.sent[0]?.content).toContain("additional event lines omitted");
	});

	it("pauses after five consecutive monitor wakes and resumes only after explicit rearm", () => {
		const { notifier, pauseMonitors, scheduler, sent } = createNotifier();
		for (let index = 1; index <= 5; index++) {
			notifier.notifyEvent(line("bash_budget", "budget", `wake-${index}`));
			scheduler.advanceBy(index === 1 ? 2000 : 5000);
		}

		expect(sent).toHaveLength(5);
		expect(sent[4]?.content).toContain("paused - peek bash_output or re-arm");
		expect(pauseMonitors).toHaveBeenCalledTimes(1);
		notifier.rearm("bash_budget");
		notifier.notifyEvent(line("bash_budget", "budget", "resumed"));
		scheduler.advanceBy(2000);
		expect(sent).toHaveLength(6);
		expect(sent[5]?.content).toContain("resumed");
	});

	it("never injects monitor events in off, print, or json modes", () => {
		for (const options of [
			{ mode: "off" as const },
			{ ctxMode: "print" },
			{ ctxMode: "json" },
			{ hasModel: false },
		]) {
			const { notifier, scheduler, sent } = createNotifier(options);
			notifier.notifyEvent(line("bash_suppressed", "suppressed", "hidden"));
			scheduler.advanceBy(10_000);
			expect(sent).toHaveLength(0);
		}
	});

	it("teaches watcher discipline in the terminal prompt", () => {
		expect(TERMINAL_PROMPT_SECTION).toContain("monitor");
		expect(TERMINAL_PROMPT_SECTION).toContain("decision-relevant");
	});
});
