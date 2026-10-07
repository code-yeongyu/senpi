import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalSessionExit } from "@earendil-works/pi-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTerminalMonitorEndedEvent } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import { TerminalSessionBundle } from "../../src/core/extensions/builtin/terminal/session-bundle.ts";
import { createNotifier, line, summary } from "./terminal-monitor-notify-harness.ts";

class Runtime {
	exitResult: TerminalSessionExit | null = null;
	readonly output = new Set<(text: string) => void>();
	readonly exits = new Set<() => void>();
	readonly session = {
		onExit: (listener: () => void) => {
			this.exits.add(listener);
			return () => this.exits.delete(listener);
		},
	};
	get exited() {
		return this.exitResult !== null;
	}
	fullOutput() {
		return "";
	}
	onOutput(listener: (text: string) => void) {
		this.output.add(listener);
		return () => this.output.delete(listener);
	}
	feed(text: string) {
		for (const listener of this.output) listener(text);
	}
	finish(exit: TerminalSessionExit) {
		this.exitResult = exit;
		for (const listener of this.exits) listener();
	}
	asRuntime() {
		return this as unknown as TerminalRuntimeSession;
	}
}

afterEach(() => vi.useRealTimers());

describe("monitor telemetry", () => {
	it("rejects incomplete or non-finite ended telemetry at the event boundary", () => {
		const valid = {
			id: "bash_1",
			description: "watch",
			startedAtMs: 1000,
			endedAtMs: 2000,
			reason: "exit",
			exitCode: 0,
			fireCount: 2,
		};
		expect(isTerminalMonitorEndedEvent(valid)).toBe(true);
		expect(isTerminalMonitorEndedEvent({ id: "bash_1", reason: "exit" })).toBe(false);
		expect(isTerminalMonitorEndedEvent({ ...valid, endedAtMs: Infinity })).toBe(false);
		expect(isTerminalMonitorEndedEvent({ ...valid, fireCount: -1 })).toBe(false);
		expect(isTerminalMonitorEndedEvent({ ...valid, exitCode: "0" })).toBe(false);
	});

	it("snapshots persistent and deadline watches and counts only emitted events", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const fired = vi.fn();
		const registry = new MonitorRegistry(() => {}, { onFire: fired });
		const runtime = new Runtime();
		try {
			registry.register({
				id: "bash_1",
				description: "standing",
				runtime: runtime.asRuntime(),
				command: "cat",
				filter: /^READY$/,
				persistent: true,
				deadlineMs: null,
			});
			registry.register({
				id: "bash_2",
				description: "bounded",
				runtime: new Runtime().asRuntime(),
				command: "build",
				persistent: false,
				deadlineMs: 6000,
			});
			expect(registry.snapshot()).toMatchObject([
				{
					command: "cat",
					filter: "^READY$",
					persistent: true,
					deadlineMs: null,
					fireCount: 0,
					lastFiredAtMs: null,
				},
				{ command: "build", filter: null, persistent: false, deadlineMs: 6000, fireCount: 0, lastFiredAtMs: null },
			]);
			runtime.feed("ignored\nREADY\n");
			registry.pause(["bash_1"]);
			runtime.feed("READY\n");
			registry.resume();
			vi.setSystemTime(2000);
			runtime.feed("READY\n");
			expect(registry.snapshot()[0]).toMatchObject({ fireCount: 2, lastFiredAtMs: 2000 });
			expect(fired).toHaveBeenCalledTimes(2);
			expect(fired.mock.lastCall?.[0][0]).toMatchObject({ fireCount: 2, lastFiredAtMs: 2000 });
		} finally {
			registry.dispose();
		}
	});

	it.each(["exit", "timeout", "killed", "disposed"] as const)(
		"reports %s once, including final summary in fireCount",
		(reason) => {
			vi.useFakeTimers();
			vi.setSystemTime(1000);
			const ended = vi.fn();
			const registry = new MonitorRegistry(() => {}, { onEnded: ended });
			const runtime = new Runtime();
			registry.register({
				id: "bash_1",
				description: "watch",
				runtime: runtime.asRuntime(),
				command: "cat",
				persistent: false,
				deadlineMs: 2000,
			});
			runtime.feed("READY\n");
			vi.setSystemTime(2000);
			const exit: TerminalSessionExit = {
				backend: "pipe-fallback",
				exitCode: reason === "exit" ? 7 : null,
				signal: null,
				timedOut: reason === "timeout",
				cancelled: reason === "killed",
			};
			if (reason === "disposed") registry.dispose();
			else runtime.finish(exit);
			runtime.finish(exit);
			registry.dispose();
			expect(ended).toHaveBeenCalledExactlyOnceWith({
				id: "bash_1",
				description: "watch",
				startedAtMs: 1000,
				endedAtMs: 2000,
				reason,
				exitCode: exit.exitCode,
				fireCount: reason === "disposed" ? 1 : 2,
			});
			expect(registry.snapshot()).toEqual([]);
		},
	);

	it("replays an ended event once across an extension reload", async () => {
		const bundle = new TerminalSessionBundle({});
		const runtime = new Runtime();
		const ended = vi.fn();
		try {
			bundle.monitors.register({
				id: "bash_1",
				description: "reload",
				runtime: runtime.asRuntime(),
				command: "cat",
				persistent: true,
				deadlineMs: null,
			});
			bundle.park();
			runtime.finish({ backend: "pipe-fallback", exitCode: 0, signal: null, timedOut: false, cancelled: false });
			const sinks = {
				onMonitorEvent: vi.fn(),
				onMonitorState: vi.fn(),
				onMonitorEnded: ended,
				onBackgroundState: vi.fn(),
				onBackgroundExit: vi.fn(),
			};
			bundle.bind(sinks);
			bundle.bind(sinks);
			expect(ended).toHaveBeenCalledTimes(1);
		} finally {
			await bundle.teardown();
		}
	});

	it.each(["timeout", "killed", "disposed"] as const)("ends native file watches once on %s", async (reason) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.setSystemTime(1000);
		const cwd = mkdtempSync(join(tmpdir(), "monitor-telemetry-"));
		const ended = vi.fn();
		const registry = new MonitorRegistry(() => {}, { onEnded: ended });
		try {
			const { id } = await registry.registerFile({
				description: "file",
				cwd,
				path: "ready",
				event: "create",
				timeoutMs: 5000,
			});
			expect(registry.snapshot()[0]).toMatchObject({
				command: null,
				filter: null,
				persistent: false,
				deadlineMs: 6000,
				fireCount: 0,
				lastFiredAtMs: null,
			});
			if (reason === "timeout") vi.advanceTimersByTime(5000);
			else if (reason === "killed") await registry.stopFile(id);
			else registry.dispose();
			await registry.stopFile(id);
			registry.dispose();
			expect(ended).toHaveBeenCalledExactlyOnceWith({
				id,
				description: "file",
				startedAtMs: 1000,
				endedAtMs: reason === "timeout" ? 6000 : 1000,
				reason,
				exitCode: null,
				fireCount: 1,
			});
		} finally {
			registry.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("attributes every coalesced monitor, including overflow-only monitors", () => {
		const { notifier, scheduler, sent } = createNotifier({ settings: { maxLinesPerInjection: 1 } });
		notifier.notifyEvent(line("A", "compile", "one"));
		notifier.notifyEvent(line("B", "logs", "two"));
		notifier.notifyEvent(line("B", "logs", "three"));
		notifier.notifyEvent(summary("A", "compile", "done"));
		scheduler.advanceBy(2000);
		expect(sent[0]?.message).toMatchObject({
			details: {
				monitors: [
					{ id: "A", description: "compile", eventCount: 2, kinds: ["line", "summary"] },
					{ id: "B", description: "logs", eventCount: 2, kinds: ["line"] },
				],
			},
		});
	});
});
