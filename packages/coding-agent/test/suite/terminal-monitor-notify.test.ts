import { describe, expect, it } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createMonitorTool } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import { createNotifier, line, summary } from "./terminal-monitor-notify-harness.ts";

describe("terminal monitor event delivery", () => {
	it("coalesces a burst into one wake containing each event line", () => {
		const { notifier, scheduler, sent } = createNotifier();
		for (let index = 1; index <= 10; index++) notifier.notifyEvent(line("bash_1", "build", `line-${index}`));

		scheduler.advanceBy(2000);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toEqual({
			customType: "senpi-monitor:notification",
			content: expect.stringContaining("Monitor event(build): line-1\nline-2"),
			display: false,
		});
		expect(sent[0]?.message.content).toContain("line-10");
		expect(sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	});

	it("queues monitor events as a follow-up in next-turn mode", () => {
		const { notifier, scheduler, sent } = createNotifier({ mode: "next-turn" });
		notifier.notifyEvent(line("bash_next", "next", "queued"));
		scheduler.advanceBy(2000);
		expect(sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	});

	it("forces only the pause-triggering next-turn batch to steer", () => {
		const { notifier, pauseMonitors, scheduler, sent } = createNotifier({
			mode: "next-turn",
			settings: { coalesceWindowMs: 10, rateLimitMs: 100, wakeBudget: 2 },
		});
		notifier.notifyEvent(line("bash_next_pause", "next-pause", "wake-1"));
		scheduler.advanceBy(10);
		expect(sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });

		notifier.notifyEvent(line("bash_next_pause", "next-pause", "wake-2"));
		scheduler.advanceBy(100);

		expect(sent).toHaveLength(2);
		expect(sent[1]?.message.content).toContain("Monitor paused after repeated updates");
		expect(sent[1]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(pauseMonitors).toHaveBeenCalledTimes(1);
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
		expect(sent[1]?.message.content).toContain("second");
	});

	it("breaks the wake streak after a gap longer than twice the rate limit", () => {
		const { notifier, pauseMonitors, scheduler, sent } = createNotifier({
			settings: { coalesceWindowMs: 10, rateLimitMs: 100, wakeBudget: 2 },
		});
		for (let index = 1; index <= 3; index++) {
			notifier.notifyEvent(line("bash_progress", "progress", `step-${index}`));
			scheduler.advanceBy(10);
			if (index < 3) scheduler.advanceBy(201);
		}

		expect(sent).toHaveLength(3);
		expect(sent.every(({ message }) => !message.content.includes("Monitor paused"))).toBe(true);
		expect(pauseMonitors).not.toHaveBeenCalled();
	});

	it("coalesces monitors that fire in the same wake window", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent(line("bash_a", "compile", "READY"));
		notifier.notifyEvent(line("bash_b", "logs", "ERROR"));
		scheduler.advanceBy(2000);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.content).toContain("Monitor event(compile): READY");
		expect(sent[0]?.message.content).toContain("Monitor event(logs): ERROR");
	});

	it("caps a wake at 50 lines and 4KB, summarizing overflow that remains peekable", () => {
		const { notifier, scheduler, sent } = createNotifier();
		for (let index = 1; index <= 52; index++) notifier.notifyEvent(line("bash_cap", "cap", `event-${index}`));
		scheduler.advanceBy(2000);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.content).toContain("event-50");
		expect(sent[0]?.message.content).toContain("2 additional event lines omitted; peek bash_output");
		expect(sent[0]?.message.content.length).toBeLessThanOrEqual(4096);

		const oversized = createNotifier();
		for (let index = 1; index <= 3; index++) {
			oversized.notifier.notifyEvent(line("bash_bytes", "bytes", "x".repeat(3000)));
		}
		oversized.scheduler.advanceBy(2000);
		expect(oversized.sent[0]?.message.content.length).toBeLessThanOrEqual(4096);
		expect(oversized.sent[0]?.message.content).toContain("additional event lines omitted");
	});

	it("pauses after five consecutive monitor wakes and resumes only after explicit rearm", () => {
		const { notifier, pauseMonitors, scheduler, sent } = createNotifier();
		for (let index = 1; index <= 5; index++) {
			notifier.notifyEvent(line("bash_budget", "budget", `wake-${index}`));
			scheduler.advanceBy(index === 1 ? 2000 : 5000);
		}

		expect(sent).toHaveLength(5);
		expect(sent[4]?.message.content).toContain("Monitor event(budget): wake-5");
		expect(pauseMonitors).toHaveBeenCalledTimes(1);
		notifier.rearm("bash_budget");
		notifier.notifyEvent(line("bash_budget", "budget", "resumed"));
		scheduler.advanceBy(2000);
		expect(sent).toHaveLength(6);
		expect(sent[5]?.message.content).toContain("resumed");
	});

	it("delivers a paused monitor completion without rearm", () => {
		const { notifier, pauseMonitors, scheduler, sent } = createNotifier({
			settings: { coalesceWindowMs: 10, rateLimitMs: 5000, wakeBudget: 1 },
		});
		notifier.notifyEvent(line("bash_wait", "wait", "still running"));
		scheduler.advanceBy(10);
		expect(sent).toHaveLength(1);

		notifier.notifyEvent(line("bash_wait", "wait", "still running"));
		scheduler.advanceBy(10);
		expect(sent).toHaveLength(1);

		notifier.notifyEvent(summary("bash_wait", "wait", "watcher completed (exit code 0)"));
		scheduler.advanceBy(10);

		expect(sent).toHaveLength(2);
		expect(sent[1]?.message.content).toContain("watcher completed (exit code 0)");
		expect(sent[1]?.options).toMatchObject({ triggerTurn: true });
		expect(pauseMonitors).toHaveBeenCalledTimes(1);
	});

	it("delivers completion from a new monitor after the prior wake budget paused", async () => {
		const { notifier, scheduler, sent } = createNotifier({ settings: { wakeBudget: 1 } });
		notifier.notifyEvent(line("bash_prior", "prior", "budget exhausted"));
		scheduler.advanceBy(2000);
		expect(sent).toHaveLength(1);

		const manager = new TerminalManager();
		const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		try {
			let resolveSummary: (() => void) | undefined;
			const summary = new Promise<void>((resolve) => {
				resolveSummary = resolve;
			});
			const registry = new MonitorRegistry((event) => {
				notifier.notifyEvent(event);
				if (event.type === "summary") resolveSummary?.();
			});
			const ctx = {
				manager,
				monitorRegistry: registry,
				onMonitorRearmed: (id: string) => notifier.rearm(id),
				cwd: process.cwd(),
				defaultCols: 120,
				defaultRows: 40,
				getEnv: () => ({ ...process.env }),
			} satisfies TerminalToolContext;

			await createMonitorTool(ctx).execute("fresh-monitor", {
				description: "fresh completion",
				command: "printf 'done\\n'",
			});
			await summary;
			scheduler.advanceBy(2000);

			expect(sent).toHaveLength(2);
			expect(sent[1]?.message.content).toContain("Monitor event(fresh completion): done");
			expect(sent[1]?.message.content).toContain("watcher completed (exit code 0)");
			expect(sent[1]?.options).toMatchObject({ triggerTurn: true });
		} finally {
			await manager.teardown();
			if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
			else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		}
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
});
