import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildToolContext,
	bundleSinks,
	type TerminalExtensionState,
} from "../../../src/core/extensions/builtin/terminal/extension-state.ts";
import { MonitorNotifier } from "../../../src/core/extensions/builtin/terminal/monitor-notify.ts";
import * as monitorStateDir from "../../../src/core/extensions/builtin/terminal/monitor-state-dir.ts";
import { TerminalNotifier } from "../../../src/core/extensions/builtin/terminal/notify.ts";
import { buildRestoreDigest, createDigestSlot } from "../../../src/core/extensions/builtin/terminal/restore-digest.ts";
import { flushRestoreDigest } from "../../../src/core/extensions/builtin/terminal/restore-session.ts";
import type { TerminalSessionBundle } from "../../../src/core/extensions/builtin/terminal/session-bundle.ts";
import { TERMINAL_SETTINGS_DEFAULTS } from "../../../src/core/extensions/builtin/terminal/settings.ts";
import { StaleExtensionContextError } from "../../../src/core/extensions/stale-context-error.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { line } from "../terminal-monitor-notify-harness.ts";
import { armRpcCheckpoint, disposeRpcCheckpoints, fireRpcCheckpoint } from "./4711-rpc-checkpoint-support.ts";

// #4711: independently exercise each deferred notification boundary with guarded getters,
// not a mock delivery function that already implements retirement.
function fixture() {
	let failure: Error | undefined;
	const read = <T>(value: T): T => {
		if (failure) throw failure;
		return value;
	};
	const ctx = {
		get mode() {
			return read("rpc");
		},
		get model() {
			return read({ id: "test-model" });
		},
		get ui() {
			return read({ notify: vi.fn() });
		},
		get sessionManager() {
			return read({
				getSessionId: () => "test-session",
				getSessionFile: () => undefined,
				getSessionDir: () => "/unused-terminal-test-dir",
			});
		},
	} as unknown as ExtensionContext;
	const sendMessage = vi.fn();
	const deps = { getContext: () => ctx, getMode: () => "wake" as const, sendMessage };
	const monitor = new MonitorNotifier({
		...deps,
		getSettings: () => TERMINAL_SETTINGS_DEFAULTS.monitor,
		pauseMonitors: () => [],
	});
	const completion = new TerminalNotifier(deps);
	const state = {
		ctx,
		settings: TERMINAL_SETTINGS_DEFAULTS,
		digestSlot: createDigestSlot(),
		bundle: null,
		keeper: null,
		monitorNotifier: monitor,
		statusTicker: { stop: vi.fn() },
		recordedBackgroundIds: new Set<string>(),
		manifestWriter: null,
	} as unknown as TerminalExtensionState;
	const pi = { sendMessage } as unknown as ExtensionAPI;
	const removal = Promise.withResolvers<void>();
	let removalResult: Promise<void> | undefined;
	state.digestSlot.set(
		buildRestoreDigest(
			{
				restored: 0,
				lost: 0,
				expired: 0,
				muted: 0,
				completed: 0,
				attachedElsewhere: 0,
				storeError: false,
				results: [],
				backgroundSessions: [],
				downtimeMs: 0,
			},
			{ generation: 1, outcome: "decided" },
		),
	);
	return {
		monitor,
		completion,
		state,
		pi,
		sendMessage,
		fail: (error: Error) => {
			failure = error;
		},
		armRemoval() {
			state.bundle = { manager: { monitorIdOf: () => "mon_test" } } as unknown as TerminalSessionBundle;
			vi.spyOn(monitorStateDir, "removeMonitorStateDir").mockReturnValue(removal.promise);
			const caught = vi.spyOn(removal.promise, "catch");
			bundleSinks(pi, state).onMonitorEnded(ended);
			removalResult = caught.mock.results[0]?.value;
		},
		rejectRemoval() {
			removal.reject(new Error("state directory removal failed"));
			return removalResult;
		},
	};
}

const ended = {
	id: "bash_1",
	reason: "exit" as const,
	description: "build",
	startedAtMs: 0,
	endedAtMs: 2000,
	exitCode: 0,
	fireCount: 0,
};

const cases = [
	...(["record", "lost"] as const).map((source) => ({
		name: `persistent RPC ${source} checkpoint`,
		capturesContext: true,
		arm: ({ state, pi }: ReturnType<typeof fixture>) => armRpcCheckpoint(state, pi),
		fire: ({ state }: ReturnType<typeof fixture>) => fireRpcCheckpoint(state, source),
	})),
	{
		name: "monitor flush timer",
		arm: ({ monitor }: ReturnType<typeof fixture>) => monitor.notifyEvent(line("bash_1", "build", "ready")),
		fire: () => vi.advanceTimersByTime(2000),
	},
	{
		name: "monitor event callback",
		arm: () => {},
		fire: ({ monitor }: ReturnType<typeof fixture>) => monitor.notifyEvent(line("bash_1", "build", "ready")),
	},
	{
		name: "background completion callback",
		arm: () => {},
		fire: ({ completion }: ReturnType<typeof fixture>) =>
			completion.notifyCompletion("bash_1", { exitResult: null, fullOutput: () => "" }),
	},
	{
		name: "monitor ended callback",
		arm: () => {},
		fire: ({ state, pi }: ReturnType<typeof fixture>) => bundleSinks(pi, state).onMonitorEnded(ended),
	},
	{
		name: "monitor cleanup rejection",
		arm: (f: ReturnType<typeof fixture>) => f.armRemoval(),
		fire: (f: ReturnType<typeof fixture>) => f.rejectRemoval(),
	},
	{
		name: "background widget callback",
		arm: ({ state }: ReturnType<typeof fixture>) => {
			state.bundle = {
				notifyBackgroundStart: () => {},
				manager: { get: () => ({}) },
			} as unknown as TerminalSessionBundle;
		},
		fire: ({ state, pi }: ReturnType<typeof fixture>) =>
			buildToolContext(pi, state).onBackgroundStart?.("bash_1", "build", 0),
	},
	{
		name: "restore digest continuation",
		arm: () => {},
		fire: ({ state, pi }: ReturnType<typeof fixture>) => flushRestoreDigest(pi, state),
	},
	{
		name: "silent restore digest continuation",
		arm: ({ state }: ReturnType<typeof fixture>) => {
			state.settings = { ...state.settings, notify: "off" };
		},
		fire: ({ state, pi }: ReturnType<typeof fixture>) => flushRestoreDigest(pi, state),
	},
];

describe("#4711 deferred terminal context readers", () => {
	afterEach(async () => {
		await disposeRpcCheckpoints();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each(cases)("$name handles retirement without an uncaught error", async (testCase) => {
		vi.useFakeTimers();
		const f = fixture();
		await testCase.arm(f);
		f.fail(new StaleExtensionContextError("retired test generation"));
		await testCase.fire(f);
		expect(vi.getTimerCount()).toBe(0);
		expect(f.sendMessage).not.toHaveBeenCalled();
		vi.advanceTimersByTime(60_000);
		expect(f.sendMessage).not.toHaveBeenCalled();
		f.monitor.dispose();
	});

	it.each(cases.filter((testCase) => !("capturesContext" in testCase)))(
		"$name rethrows a non-stale failure unchanged",
		async (testCase) => {
			vi.useFakeTimers();
			const f = fixture();
			testCase.arm(f);
			const error = new Error("unexpected context failure");
			f.fail(error);
			await expect(Promise.resolve().then(() => testCase.fire(f))).rejects.toBe(error);
			f.monitor.dispose();
		},
	);

	it.each(["record", "lost"] as const)("RPC %s checkpoint preserves unrelated writer failures", async (source) => {
		vi.useFakeTimers();
		const f = fixture();
		await armRpcCheckpoint(f.state, f.pi);
		f.fail(new StaleExtensionContextError("retired test generation"));
		const error = new Error("unexpected checkpoint failure");
		await expect(fireRpcCheckpoint(f.state, source, error)).rejects.toBe(error);
	});

	it("disposes the pending batch when its flush discovers retirement", () => {
		vi.useFakeTimers();
		const f = fixture();
		const dispose = vi.spyOn(f.monitor, "dispose");
		f.monitor.notifyEvent(line("bash_1", "build", "ready"));
		f.fail(new StaleExtensionContextError("retired test generation"));
		expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
		expect(dispose).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retires a completion notifier instead of retrying its retired context", () => {
		const f = fixture();
		f.fail(new StaleExtensionContextError("retired test generation"));
		f.completion.notifyCompletion("bash_1", { exitResult: null, fullOutput: () => "" });
		f.fail(new Error("a retired notifier must not read context again"));
		expect(() => f.completion.notifyCompletion("bash_2", { exitResult: null, fullOutput: () => "" })).not.toThrow();
		expect(f.sendMessage).not.toHaveBeenCalled();
	});
});
