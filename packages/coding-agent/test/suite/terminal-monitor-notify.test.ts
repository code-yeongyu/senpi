import { describe, expect, it } from "vitest";
import { TERMINAL_PROMPT_SECTION } from "../../src/core/extensions/builtin/terminal/prompt.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createMonitorTool } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import { createNotifier, line } from "./terminal-monitor-notify-harness.ts";

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
		expect(sent[4]?.message.content).toContain("paused - peek bash_output or re-arm");
		expect(pauseMonitors).toHaveBeenCalledTimes(1);
		notifier.rearm("bash_budget");
		notifier.notifyEvent(line("bash_budget", "budget", "resumed"));
		scheduler.advanceBy(2000);
		expect(sent).toHaveLength(6);
		expect(sent[5]?.message.content).toContain("resumed");
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

	it("teaches watcher discipline at the owning terminal surfaces", () => {
		expect(TERMINAL_PROMPT_SECTION).toContain("monitor");
		// Discipline is the routing rule (waits are monitors, not poll loops) plus noise control,
		// not any particular wording — assert each rule at the surface that owns it, never a
		// pinned sentence: the routing rule ships as the monitor tool's guideline, the noise
		// rule stays in the terminal section.
		const stubCtx = {
			manager: { get: () => undefined },
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => process.env,
		} as unknown as TerminalToolContext;
		const guidelines = (createMonitorTool(stubCtx).promptGuidelines ?? []).join("\n");
		expect(guidelines).toMatch(/never a foreground\s+sleep\/poll loop/);
		expect(TERMINAL_PROMPT_SECTION).toMatch(/Filter\s+noise at the command source/);
	});
});
