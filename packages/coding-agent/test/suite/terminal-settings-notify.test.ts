import { describe, expect, it } from "vitest";
import { TerminalNotifier, type TerminalNotifierDeps } from "../../src/core/extensions/builtin/terminal/notify.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import {
	resolveTerminalSettings,
	TERMINAL_SETTINGS_DEFAULTS,
} from "../../src/core/extensions/builtin/terminal/settings.ts";

const exitedRuntime = {
	exited: true,
	exitResult: { exitCode: 0, timedOut: false, cancelled: false, signal: null, backend: "native" },
	fullOutput: () => "done\n",
} as unknown as TerminalRuntimeSession;

type CapturedNotification = {
	readonly content: string;
	readonly options: Parameters<TerminalNotifierDeps["sendUserMessage"]>[1];
};

function makeNotifier(overrides: {
	mode?: "wake" | "next-turn" | "off";
	ctxMode?: string;
	hasModel?: boolean;
	sink: CapturedNotification[];
}) {
	return new TerminalNotifier({
		sendUserMessage: (content, options) => overrides.sink.push({ content, options }),
		getMode: () => overrides.mode ?? "wake",
		getContext: () =>
			({
				mode: overrides.ctxMode ?? "tui",
				model: overrides.hasModel === false ? undefined : { id: "m", api: "anthropic-messages" },
			}) as never,
	});
}

describe("terminal settings resolver", () => {
	it("fills defaults when no terminal block is present", () => {
		expect(resolveTerminalSettings(undefined)).toEqual(TERMINAL_SETTINGS_DEFAULTS);
		expect(TERMINAL_SETTINGS_DEFAULTS).toMatchObject({
			defaultCols: 120,
			defaultRows: 40,
			scrollback: 10000,
			maxSessions: 32,
			timeoutAction: "background",
			notify: "wake",
			monitor: {
				coalesceWindowMs: 2000,
				rateLimitMs: 5000,
				maxLinesPerInjection: 50,
				maxCharsPerInjection: 4096,
				wakeBudget: 5,
			},
		});
	});

	it("overrides valid values and rejects invalid ones", () => {
		const resolved = resolveTerminalSettings({
			defaultCols: 200,
			maxSessions: 0,
			notify: "off",
			timeoutAction: "bogus" as never,
		});
		expect(resolved.defaultCols).toBe(200);
		expect(resolved.maxSessions).toBe(32); // 0 is invalid → default
		expect(resolved.notify).toBe("off");
		expect(resolved.timeoutAction).toBe("background"); // invalid → default
	});

	it("resolves bounded monitor-delivery settings", () => {
		const resolved = resolveTerminalSettings({
			monitorCoalesceWindowMs: 1200,
			monitorRateLimitMs: 7000,
			monitorMaxLinesPerInjection: 75,
			monitorMaxCharsPerInjection: 8000,
			monitorWakeBudget: 9,
		});
		expect(resolved.monitor).toEqual({
			coalesceWindowMs: 1200,
			rateLimitMs: 7000,
			maxLinesPerInjection: 75,
			maxCharsPerInjection: 8000,
			wakeBudget: 9,
		});
		expect(resolveTerminalSettings({ monitorMaxLinesPerInjection: 0 }).monitor.maxLinesPerInjection).toBe(50);
	});
});

describe("terminal notifier completion payload", () => {
	const exitedWithOutput = (output: string, exitCode = 0) =>
		({
			exited: true,
			exitResult: { exitCode, timedOut: false, cancelled: false, signal: null, backend: "native" },
			fullOutput: () => output,
		}) as unknown as TerminalRuntimeSession;

	it("embeds the exit code and final output tail instead of a bash_output instruction", () => {
		// Given: a finished background session that produced output.
		const sink: CapturedNotification[] = [];
		const notifier = makeNotifier({ sink, mode: "wake" });

		// When: the completion notification fires.
		notifier.notifyCompletion("bash_1", exitedWithOutput("A\nB\nLAST\n", 3));

		// Then: the notice carries the exit code and the output tail, and never tells the
		// agent to burn a follow-up bash_output call.
		expect(sink).toHaveLength(1);
		const content = sink[0]?.content ?? "";
		expect(content).toContain("exit code 3");
		expect(content).toContain("LAST");
		expect(content).not.toContain("Use bash_output");
	});

	it("caps an oversized tail and notes the full history is still peekable", () => {
		// Given: a finished session whose retained output far exceeds the notice budget.
		const sink: CapturedNotification[] = [];
		const notifier = makeNotifier({ sink, mode: "wake" });
		const huge = `${"filler\n".repeat(1000)}TAIL_END\n`;

		// When: the completion notification fires.
		notifier.notifyCompletion("bash_1", exitedWithOutput(huge, 0));

		// Then: the tail is bounded with a truncation note pointing at the peekable history.
		const content = sink[0]?.content ?? "";
		expect(content).toContain("TAIL_END");
		expect(content).toContain("truncat");
		expect(content.length).toBeLessThan(4000);
		expect(content).not.toContain("Use bash_output");
	});
});

describe("terminal notifier guards", () => {
	it("wakes an idle interactive agent exactly once per session", () => {
		// Given: wake notifications are enabled for an interactive session with a model.
		const sink: CapturedNotification[] = [];
		const notifier = makeNotifier({ sink, mode: "wake" });

		// When: the same terminal completion is reported twice.
		notifier.notifyCompletion("bash_1", exitedRuntime);
		notifier.notifyCompletion("bash_1", exitedRuntime);

		// Then: one steering notification carries the completion notice.
		expect(sink).toHaveLength(1);
		expect(sink[0]?.content).toContain("bash_1");
		expect(sink[0]?.content).toContain("<system-reminder>");
		expect(sink[0]?.options).toEqual({ deliverAs: "steer" });
	});

	it("queues next-turn completion as a follow-up", () => {
		// Given: next-turn notifications are enabled for an interactive session with a model.
		const sink: CapturedNotification[] = [];
		const notifier = makeNotifier({ sink, mode: "next-turn" });

		// When: the terminal session completes.
		notifier.notifyCompletion("bash_1", exitedRuntime);

		// Then: the notice is queued as a follow-up message.
		expect(sink).toHaveLength(1);
		expect(sink[0]?.content).toContain("bash_1");
		expect(sink[0]?.options).toEqual({ deliverAs: "followUp" });
	});

	it("surfaces extension injections only in interactive modes", () => {
		const modeMatrix = [
			{ mode: "tui", surfaces: true },
			{ mode: "rpc", surfaces: true },
			{ mode: "app-server", surfaces: true },
			{ mode: "print", surfaces: false },
			{ mode: "json", surfaces: false },
		] as const;

		for (const { mode, surfaces } of modeMatrix) {
			const sink: CapturedNotification[] = [];
			makeNotifier({ sink, ctxMode: mode }).notifyCompletion(`bash_${mode}`, exitedRuntime);
			expect(sink, mode).toHaveLength(surfaces ? 1 : 0);
		}
	});

	it("suppresses when notify is off or no model is active", () => {
		const off: CapturedNotification[] = [];
		makeNotifier({ sink: off, mode: "off" }).notifyCompletion("bash_1", exitedRuntime);
		expect(off).toHaveLength(0);

		const noModel: CapturedNotification[] = [];
		makeNotifier({ sink: noModel, hasModel: false }).notifyCompletion("bash_1", exitedRuntime);
		expect(noModel).toHaveLength(0);
	});
});
