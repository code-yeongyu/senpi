import { describe, expect, it } from "vitest";
import { TerminalNotifier } from "../../src/core/extensions/builtin/terminal/notify.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import {
	resolveTerminalSettings,
	TERMINAL_SETTINGS_DEFAULTS,
} from "../../src/core/extensions/builtin/terminal/settings.ts";

const exitedRuntime = {
	exited: true,
	exitResult: { exitCode: 0, timedOut: false, cancelled: false, signal: null, backend: "native" },
} as unknown as TerminalRuntimeSession;

function makeNotifier(overrides: {
	mode?: "wake" | "next-turn" | "off";
	ctxMode?: string;
	hasModel?: boolean;
	sink: string[];
}) {
	return new TerminalNotifier({
		sendUserMessage: (content) => overrides.sink.push(content),
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
});

describe("terminal notifier guards", () => {
	it("wakes an idle interactive agent exactly once per session", () => {
		const sink: string[] = [];
		const notifier = makeNotifier({ sink });
		notifier.notifyCompletion("bash_1", exitedRuntime);
		notifier.notifyCompletion("bash_1", exitedRuntime);
		expect(sink).toHaveLength(1);
		expect(sink[0]).toContain("bash_1");
		expect(sink[0]).toContain("<system-reminder>");
	});

	it("never wakes in one-shot print/json runs", () => {
		const sink: string[] = [];
		makeNotifier({ sink, ctxMode: "print" }).notifyCompletion("bash_1", exitedRuntime);
		makeNotifier({ sink, ctxMode: "json" }).notifyCompletion("bash_2", exitedRuntime);
		expect(sink).toHaveLength(0);
	});

	it("suppresses when notify is off or no model is active", () => {
		const off: string[] = [];
		makeNotifier({ sink: off, mode: "off" }).notifyCompletion("bash_1", exitedRuntime);
		expect(off).toHaveLength(0);

		const noModel: string[] = [];
		makeNotifier({ sink: noModel, hasModel: false }).notifyCompletion("bash_1", exitedRuntime);
		expect(noModel).toHaveLength(0);
	});
});
