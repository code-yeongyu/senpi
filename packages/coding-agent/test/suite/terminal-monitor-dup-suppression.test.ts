import { describe, expect, it } from "vitest";
import { createNotifier, line, summary } from "./terminal-monitor-notify-harness.ts";

/**
 * A status watcher (e.g. `gh pr checks --watch`) reprints the same lines on every refresh.
 * Re-waking the session for byte-identical monitor output replays the whole context for
 * zero new information, so a batch whose lines match the monitor's previous injection is
 * dropped silently: no injection, no wake-budget tick. Any content change wakes as before,
 * and summary (exit) events always deliver.
 */
describe("monitor duplicate-batch suppression", () => {
	it("does not re-wake when a monitor repeats the exact same lines", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent(line("bash_ci", "ci", "4 pending 0 failing"));
		scheduler.advanceBy(2000);
		expect(sent).toHaveLength(1);

		notifier.notifyEvent(line("bash_ci", "ci", "4 pending 0 failing"));
		scheduler.advanceBy(10_000);
		notifier.notifyEvent(line("bash_ci", "ci", "4 pending 0 failing"));
		scheduler.advanceBy(10_000);

		expect(sent).toHaveLength(1);
	});

	it("wakes again the moment the repeated content changes", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent(line("bash_ci", "ci", "4 pending 0 failing"));
		scheduler.advanceBy(2000);
		notifier.notifyEvent(line("bash_ci", "ci", "4 pending 0 failing"));
		scheduler.advanceBy(10_000);
		expect(sent).toHaveLength(1);

		notifier.notifyEvent(line("bash_ci", "ci", "3 pending 0 failing"));
		scheduler.advanceBy(10_000);

		expect(sent).toHaveLength(2);
		expect(sent[1]?.message.content).toContain("3 pending 0 failing");
	});

	it("suppresses a multi-line refresh only when every line matches the previous batch", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent(line("bash_tbl", "table", "job-a pass"));
		notifier.notifyEvent(line("bash_tbl", "table", "job-b pending"));
		scheduler.advanceBy(2000);
		expect(sent).toHaveLength(1);

		notifier.notifyEvent(line("bash_tbl", "table", "job-a pass"));
		notifier.notifyEvent(line("bash_tbl", "table", "job-b pending"));
		scheduler.advanceBy(10_000);
		expect(sent).toHaveLength(1);

		notifier.notifyEvent(line("bash_tbl", "table", "job-a pass"));
		notifier.notifyEvent(line("bash_tbl", "table", "job-b pass"));
		scheduler.advanceBy(10_000);
		expect(sent).toHaveLength(2);
		expect(sent[1]?.message.content).toContain("job-b pass");
	});

	it("keeps a changed monitor's wake while dropping another monitor's duplicate batch", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent(line("bash_dup", "dup", "steady state"));
		notifier.notifyEvent(line("bash_new", "new", "step 1"));
		scheduler.advanceBy(2000);
		expect(sent).toHaveLength(1);

		notifier.notifyEvent(line("bash_dup", "dup", "steady state"));
		notifier.notifyEvent(line("bash_new", "new", "step 2"));
		scheduler.advanceBy(10_000);

		expect(sent).toHaveLength(2);
		expect(sent[1]?.message.content).toContain("step 2");
		expect(sent[1]?.message.content).not.toContain("steady state");
	});

	it("always delivers summary (exit) events even after identical line batches", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent(line("bash_exit", "exit", "waiting"));
		scheduler.advanceBy(2000);
		notifier.notifyEvent(line("bash_exit", "exit", "waiting"));
		scheduler.advanceBy(10_000);
		expect(sent).toHaveLength(1);

		notifier.notifyEvent(line("bash_exit", "exit", "waiting"));
		notifier.notifyEvent(summary("bash_exit", "exit", "watcher exited (exit code 0)"));
		scheduler.advanceBy(10_000);

		expect(sent).toHaveLength(2);
		expect(sent[1]?.message.content).toContain("watcher exited (exit code 0)");
	});

	it("suppressed refreshes never consume the wake budget", () => {
		const { notifier, pauseMonitors, scheduler, sent } = createNotifier({
			settings: { coalesceWindowMs: 10, rateLimitMs: 100, wakeBudget: 2 },
		});
		notifier.notifyEvent(line("bash_budget", "budget", "state A"));
		scheduler.advanceBy(10);
		expect(sent).toHaveLength(1);

		notifier.notifyEvent(line("bash_budget", "budget", "state A"));
		scheduler.advanceBy(100);
		expect(sent).toHaveLength(1);
		expect(pauseMonitors).not.toHaveBeenCalled();

		notifier.notifyEvent(line("bash_budget", "budget", "state B"));
		scheduler.advanceBy(10);
		expect(sent).toHaveLength(2);
		expect(sent[1]?.message.content).toContain("state B");
		expect(pauseMonitors).toHaveBeenCalledTimes(1);
	});

	it("rearm clears the remembered batch so the next identical line re-injects", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent(line("bash_rearm", "rearm", "same line"));
		scheduler.advanceBy(2000);
		notifier.notifyEvent(line("bash_rearm", "rearm", "same line"));
		scheduler.advanceBy(10_000);
		expect(sent).toHaveLength(1);

		notifier.rearm("bash_rearm");
		notifier.notifyEvent(line("bash_rearm", "rearm", "same line"));
		scheduler.advanceBy(10_000);

		expect(sent).toHaveLength(2);
		expect(sent[1]?.message.content).toContain("same line");
	});
});
