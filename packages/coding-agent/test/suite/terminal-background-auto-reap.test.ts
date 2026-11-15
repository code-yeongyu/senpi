// senpi#6201: auto-reap is opt-in. With no setting and no `auto_reap_minutes` a background session runs for as long
// as it runs; with either one it is stopped through the manager's stop path (TERM, then KILL to the group) at that
// age, and the exit it reports carries the reap. The clock is vitest's fake one and the PTY is a fake; nothing sleeps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalBackgroundAgeEvent } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import {
	buildToolContext,
	type TerminalExtensionState,
} from "../../src/core/extensions/builtin/terminal/extension-state.ts";
import type { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import { TerminalSessionBundle } from "../../src/core/extensions/builtin/terminal/session-bundle.ts";
import { resolveTerminalSettings } from "../../src/core/extensions/builtin/terminal/settings.ts";
import { createPtyBashTool } from "../../src/core/extensions/builtin/terminal/tools/bash.ts";
import type {
	TerminalExitView,
	TerminalToolContext,
} from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

const MINUTE = 60_000;

const spawned = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock("../../src/core/extensions/builtin/terminal/tools/spawn.ts", () => ({
	describeExit: () => null,
	spawnCommandSession: async () => ({ id: "bash_1", runtime: spawned.runtime }),
}));

class FakeRuntime {
	readonly backend = "native";
	readonly exitListeners = new Set<() => void>();
	exited = false;
	exitResult: TerminalExitView["exitResult"] = null;
	readonly session = {
		kill: vi.fn(),
		waitExit: () => new Promise<void>(() => {}),
		onExit: (listener: () => void) => {
			this.exitListeners.add(listener);
			return () => this.exitListeners.delete(listener);
		},
	};

	exit(exit: Partial<NonNullable<TerminalExitView["exitResult"]>> = {}): void {
		if (this.exited) return;
		this.exited = true;
		this.exitResult = { exitCode: 0, signal: null, cancelled: false, timedOut: false, ...exit };
		for (const listener of this.exitListeners) listener();
	}

	onOutput(): () => void {
		return () => {};
	}

	readDelta(): { text: string; droppedChars: number } {
		return { text: "", droppedChars: 0 };
	}

	fullOutput(): string {
		return "";
	}
}

function setup(options: { backgroundAutoReapMinutes?: number } = {}) {
	const runtime = new FakeRuntime();
	spawned.runtime = runtime;
	const exits: Array<{ id: string; view: TerminalExitView }> = [];
	const starts: unknown[][] = [];
	const manager = {
		get: () => runtime as unknown as TerminalRuntimeSession,
		stop: vi.fn(async () => {
			runtime.exit({ exitCode: null, signal: "SIGTERM", cancelled: true });
			return true;
		}),
	};
	const ctx = {
		manager: manager as unknown as TerminalManager,
		cwd: "/fixture",
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => ({}),
		getSessionContext: () => ({}) as ExtensionContext,
		...(options.backgroundAutoReapMinutes === undefined
			? {}
			: { backgroundAutoReapMinutes: options.backgroundAutoReapMinutes }),
		onBackgroundStart: (...args: unknown[]) => starts.push(args),
		onBackgroundExit: (id: string, view: TerminalExitView) => exits.push({ id, view }),
	} as TerminalToolContext;
	return { runtime, manager, exits, starts, bash: createPtyBashTool(ctx) };
}

async function startBackground(bash: ReturnType<typeof setup>["bash"], extra: Record<string, unknown> = {}) {
	const result = bash.execute("call", { command: "./serve.sh", run_in_background: true, ...extra });
	await vi.advanceTimersByTimeAsync(250);
	return result;
}

/**
 * The tool context the extension builds, wired to a real session bundle, with a stop that does what `stop` says: the
 * age events the bundle emits (running, reaped, reap_failed) are what the TUI, the model and RPC drivers see.
 */
let bundles: TerminalSessionBundle[] = [];
function wiredToBundle(stop: (runtime: FakeRuntime) => Promise<boolean>) {
	const runtime = new FakeRuntime();
	spawned.runtime = runtime;
	const terminal = new TerminalSessionBundle({});
	bundles.push(terminal);
	const ages: TerminalBackgroundAgeEvent[] = [];
	const exits: TerminalExitView[] = [];
	terminal.bind({
		onMonitorEvent: () => {},
		onMonitorState: () => {},
		onMonitorEnded: () => {},
		onBackgroundState: () => {},
		onBackgroundExit: (_id, view) => exits.push(view),
		onBackgroundAge: (event) => ages.push(event),
	});
	const state = {
		bundle: terminal,
		settings: resolveTerminalSettings({ backgroundAutoReapMinutes: 60 }),
		recordedBackgroundIds: new Set<string>(),
	} as unknown as TerminalExtensionState;
	const manager = { get: () => runtime as unknown as TerminalRuntimeSession, stop: vi.fn(() => stop(runtime)) };
	const warn = vi.fn();
	const ctx: TerminalToolContext = {
		...buildToolContext({} as ExtensionAPI, state),
		manager: manager as unknown as TerminalManager,
		sessionLogger: { warn },
	};
	return { runtime, manager, warn, ages, exits, bash: createPtyBashTool(ctx) };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const terminal of bundles) await terminal.teardown();
	bundles = [];
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("background auto-reap (opt-in)", () => {
	it("is off by default: a background session survives any age and arms no timer", async () => {
		const { bash, manager, runtime, exits } = setup();
		await startBackground(bash);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(48 * 60 * MINUTE);
		expect(manager.stop).not.toHaveBeenCalled();
		expect(runtime.exited).toBe(false);
		expect(exits).toEqual([]);
	});

	it("terminal.backgroundAutoReapMinutes stops the session at that age through the stop path and reports the reap", async () => {
		const { bash, manager, exits, starts } = setup({ backgroundAutoReapMinutes: 60 });
		await startBackground(bash);
		expect(starts[0]?.[4]).toBe(60);

		await vi.advanceTimersByTimeAsync(60 * MINUTE - 251);
		expect(manager.stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(manager.stop).toHaveBeenCalledWith("bash_1");
		expect(exits).toHaveLength(1);
		expect(exits[0]?.view.autoReapedAfterMinutes).toBe(60);
		expect(exits[0]?.view.exitResult).toMatchObject({ cancelled: true, signal: "SIGTERM" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("auto_reap_minutes on the call overrides the setting, and 0 turns it off for that call", async () => {
		const opted = setup();
		await startBackground(opted.bash, { auto_reap_minutes: 5 });
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(opted.manager.stop).toHaveBeenCalledTimes(1);
		expect(opted.exits[0]?.view.autoReapedAfterMinutes).toBe(5);

		const optedOut = setup({ backgroundAutoReapMinutes: 60 });
		await startBackground(optedOut.bash, { auto_reap_minutes: 0 });
		await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE);
		expect(optedOut.manager.stop).not.toHaveBeenCalled();
		expect(optedOut.starts[0]?.[4]).toBeUndefined();
	});

	it("clears the reap timer when the session exits on its own, and that exit is not a reap", async () => {
		const { bash, manager, runtime, exits } = setup({ backgroundAutoReapMinutes: 60 });
		await startBackground(bash);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(MINUTE);
		runtime.exit();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);
		expect(manager.stop).not.toHaveBeenCalled();
		expect(exits[0]?.view.autoReapedAfterMinutes).toBeUndefined();
	});

	it("reaps an auto-detached foreground command at its age counted from its start", async () => {
		const { bash, manager } = setup({ backgroundAutoReapMinutes: 30 });
		const call = bash.execute("call", { command: "./long.sh", timeout: 100_000 });
		await vi.advanceTimersByTimeAsync(60_000);
		await call;
		await vi.advanceTimersByTimeAsync(29 * MINUTE - 1);
		expect(manager.stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(manager.stop).toHaveBeenCalledWith("bash_1");
	});
});

describe("a reap counts only once the stop really ended the session", () => {
	it("when the stop ends the session: one reaped event and an exit reported as reaped", async () => {
		const { bash, ages, exits } = wiredToBundle(async (runtime) => {
			runtime.exit({ exitCode: null, signal: "SIGTERM", cancelled: true });
			return true;
		});
		await startBackground(bash);
		await vi.advanceTimersByTimeAsync(60 * MINUTE);

		expect(ages.filter((event) => event.kind !== "running")).toEqual([
			expect.objectContaining({ kind: "reaped", id: "bash_1", autoReapMinutes: 60 }),
		]);
		expect(exits).toHaveLength(1);
		expect(exits[0]?.autoReapedAfterMinutes).toBe(60);
	});

	it.each([
		{
			case: "rejects",
			stop: async () => {
				throw new Error("EPERM: operation not permitted");
			},
			reason: "EPERM: operation not permitted",
		},
		{ case: "resolves while the session keeps running", stop: async () => true, reason: expect.any(String) },
		{ case: "finds no session to stop", stop: async () => false, reason: expect.any(String) },
	])(
		"when the stop $case: no reaped event, one reap_failed notice, the session keeps running and reporting, no retry",
		async ({ stop, reason }) => {
			const { bash, manager, runtime, warn, ages, exits } = wiredToBundle(stop);
			await startBackground(bash);
			await vi.advanceTimersByTimeAsync(60 * MINUTE);

			expect(manager.stop).toHaveBeenCalledTimes(1);
			expect(runtime.exited).toBe(false);
			expect(ages.filter((event) => event.kind !== "running")).toEqual([
				expect.objectContaining({ kind: "reap_failed", id: "bash_1", autoReapMinutes: 60, reason }),
			]);
			expect(warn).toHaveBeenCalledWith(
				"bash_auto_reap_failed",
				expect.objectContaining({ bash_id: "bash_1", autoReapMinutes: 60, error: reason }),
			);

			await vi.advanceTimersByTimeAsync(60 * MINUTE);
			expect(manager.stop).toHaveBeenCalledTimes(1);
			expect(ages.filter((event) => event.kind === "running").map((event) => event.ageMinutes)).toEqual([
				10, 40, 70, 100,
			]);

			// senpi#6252: once the reap has failed, later age notices stop promising one.
			expect(
				ages
					.filter((event) => event.kind === "running" && event.ageMinutes >= 70)
					.map((event) => event.autoReapMinutes),
			).toEqual([null, null]);

			// It ends on its own later: that exit is not a reap.
			runtime.exit();
			await vi.advanceTimersByTimeAsync(0);
			expect(exits).toHaveLength(1);
			expect(exits[0]?.autoReapedAfterMinutes).toBeUndefined();
			expect(ages.filter((event) => event.kind !== "running").map((event) => event.kind)).toEqual(["reap_failed"]);
		},
	);
});

describe("terminal.backgroundAutoReapMinutes setting", () => {
	it("defaults to off, accepts a positive whole number of minutes, and reaches the tool context", () => {
		expect(resolveTerminalSettings(undefined).backgroundAutoReapMinutes).toBeUndefined();
		expect(resolveTerminalSettings({}).backgroundAutoReapMinutes).toBeUndefined();
		for (const off of [0, -5, Number.NaN, "60"]) {
			expect(
				resolveTerminalSettings({ backgroundAutoReapMinutes: off as number }).backgroundAutoReapMinutes,
			).toBeUndefined();
		}
		expect(resolveTerminalSettings({ backgroundAutoReapMinutes: 90.7 }).backgroundAutoReapMinutes).toBe(90);

		const state = {
			settings: resolveTerminalSettings({ backgroundAutoReapMinutes: 45 }),
		} as unknown as TerminalExtensionState;
		expect(buildToolContext({} as ExtensionAPI, state).backgroundAutoReapMinutes).toBe(45);
	});
});
