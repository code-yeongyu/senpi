import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import {
	MonitorRegistry,
	type MonitorSnapshotEntry,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { formatMonitorStatus } from "../../src/core/extensions/builtin/terminal/monitor-status.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createMonitorTool, type MonitorInput } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

/** Resolves when the wrapped spy is called with a matching argument set. */
function deferredCall<TArgs extends unknown[]>(predicate: (...args: TArgs) => boolean) {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		setTimeout(() => rej(new Error("Timed out waiting for matching call")), 5000);
	});
	const handler = (...args: TArgs): void => {
		if (predicate(...args)) resolve?.();
	};
	return { promise, handler };
}

describe("formatMonitorStatus", () => {
	const T0 = 1_000_000;
	const entry = (id: string, description: string, paused = false, startedAtMs = T0): MonitorSnapshotEntry => ({
		id,
		description,
		paused,
		startedAtMs,
	});

	it("returns undefined when nothing is monitored so the footer status clears", () => {
		expect(formatMonitorStatus([], T0)).toBeUndefined();
	});

	it("marks the single watched thing with the watch glyph, description, and elapsed time", () => {
		expect(formatMonitorStatus([entry("bash_1", "errors in deploy.log")], T0 + 5_000)).toBe(
			"◉ watching errors in deploy.log (5s)",
		);
	});

	it("formats longer watches with the goal-style compact elapsed label", () => {
		expect(formatMonitorStatus([entry("bash_1", "errors in deploy.log")], T0 + 180_000)).toBe(
			"◉ watching errors in deploy.log (3m)",
		);
		expect(formatMonitorStatus([entry("bash_1", "deploy errors")], T0 + (2 * 3600 + 30 * 60) * 1000)).toBe(
			"◉ watching deploy errors (2h 30m)",
		);
	});

	it("advances the elapsed label as time passes over the same snapshot", () => {
		const snapshot = [entry("bash_1", "deploy errors")];
		expect(formatMonitorStatus(snapshot, T0 + 5_000)).toBe("◉ watching deploy errors (5s)");
		expect(formatMonitorStatus(snapshot, T0 + 6_000)).toBe("◉ watching deploy errors (6s)");
	});

	it("never shows negative elapsed when the clock moves backwards", () => {
		expect(formatMonitorStatus([entry("bash_1", "deploy errors")], T0 - 5_000)).toBe("◉ watching deploy errors (0s)");
	});

	it("lists every description when they all fit and shows the oldest watch's elapsed time", () => {
		const text = formatMonitorStatus(
			[entry("bash_1", "deploy errors"), entry("bash_2", "webpack", false, T0 + 60_000)],
			T0 + 180_000,
		);
		expect(text).toBe("◉ watching 2: deploy errors, webpack (3m)");
	});

	it("keeps whole names and folds the overflow into a +N more counter", () => {
		const text = formatMonitorStatus(
			[
				entry("bash_1", "errors in deploy.log"),
				entry("bash_2", "integration test output on ci runner four"),
				entry("bash_3", "webpack rebuild"),
			],
			T0,
		);
		expect(text).toBe("◉ watching 3: errors in deploy.log +2 more (0s)");
		expect((text ?? "").length).toBeLessThanOrEqual(48);
	});

	it("never truncates away the count when the first name alone overflows", () => {
		const text = formatMonitorStatus(
			[entry("bash_1", "a".repeat(60)), entry("bash_2", "b"), entry("bash_3", "c"), entry("bash_4", "d")],
			T0,
		);
		expect(text).toContain("watching 4:");
		expect(text).toContain("+3 more");
		expect(text).toContain("…");
		expect((text ?? "").length).toBeLessThanOrEqual(48);
	});

	it("marks paused watches and keeps the marker through truncation", () => {
		const all = formatMonitorStatus([entry("bash_1", "a", true), entry("bash_2", "b", true)], T0 + 60_000);
		expect(all).toBe("◉ watching 2: a, b (1m, paused)");
		const some = formatMonitorStatus(
			[
				entry("bash_1", "errors in deploy.log", true),
				entry("bash_2", "integration test output on ci runner four"),
				entry("bash_3", "webpack rebuild"),
			],
			T0,
		);
		expect(some).toContain("1 paused");
		expect((some ?? "").length).toBeLessThanOrEqual(48);
	});
});

describe("MonitorRegistry change notification", () => {
	let manager: TerminalManager;
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		manager = new TerminalManager();
	});

	afterEach(async () => {
		await manager.teardown();
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("reports register, pause, rearm, settle, and dispose transitions", async () => {
		const snapshots: Array<readonly MonitorSnapshotEntry[]> = [];
		const settled = deferredCall<[readonly MonitorSnapshotEntry[]]>((snapshot) => snapshot.length === 0);
		const registry = new MonitorRegistry(() => {}, {
			onChange: (snapshot) => {
				snapshots.push(snapshot);
				settled.handler(snapshot);
			},
		});
		const ctx: TerminalToolContext = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			monitorRegistry: registry,
		};
		const tool = createMonitorTool(ctx);
		const input: MonitorInput = { description: "quick echo watch", command: "printf 'one\\n'" };
		await tool.execute("call_1", input);

		expect(snapshots[0]).toEqual([
			{
				id: expect.stringContaining("bash"),
				description: "quick echo watch",
				paused: false,
				startedAtMs: expect.any(Number),
			},
		]);
		await settled.promise;
		expect(snapshots.at(-1)).toEqual([]);
	});

	it("snapshots pause state through pauseAll and rearm", async () => {
		const snapshots: Array<readonly MonitorSnapshotEntry[]> = [];
		const registry = new MonitorRegistry(() => {}, { onChange: (snapshot) => snapshots.push(snapshot) });
		const ctx: TerminalToolContext = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			monitorRegistry: registry,
		};
		const tool = createMonitorTool(ctx);
		const input: MonitorInput = { description: "long lived watch", command: "cat", persistent: true };
		await tool.execute("call_1", input);
		const registered = snapshots.at(-1);
		expect(registered?.[0]?.paused).toBe(false);

		registry.pauseAll();
		expect(snapshots.at(-1)?.[0]?.paused).toBe(true);
		expect(registry.snapshot()[0]?.paused).toBe(true);

		const id = registry.snapshot()[0]?.id ?? "";
		expect(registry.rearm(id)).toBe("rearmed");
		expect(snapshots.at(-1)?.[0]?.paused).toBe(false);

		registry.dispose();
		expect(snapshots.at(-1)).toEqual([]);
	});
});

describe("terminal extension footer status wiring", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
	});

	afterEach(() => {
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("publishes the monitors footer status while a watch is live and clears it on settle", async () => {
		initTheme("dark");
		type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
		const handlers = new Map<string, Handler[]>();
		const tools = new Map<string, { execute: (id: string, input: MonitorInput) => Promise<unknown> }>();
		let activeTools: string[] = [];
		const fakePi = {
			registerTool: (tool: { name: string; execute: (id: string, input: MonitorInput) => Promise<unknown> }) => {
				tools.set(tool.name, tool);
			},
			on: (event: string, handler: Handler) => {
				const existing = handlers.get(event) ?? [];
				existing.push(handler);
				handlers.set(event, existing);
			},
			sendUserMessage: () => {},
			getActiveTools: () => activeTools,
			setActiveTools: (next: string[]) => {
				activeTools = next;
			},
		} as unknown as ExtensionAPI;

		registerTerminalExtension(fakePi);

		const setStatus = vi.fn();
		const cleared = deferredCall<[string, string | undefined]>(
			(key, text) => key === "monitors" && text === undefined,
		);
		setStatus.mockImplementation((key: string, text: string | undefined) => cleared.handler(key, text));
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			mode: "tui",
			ui: { setStatus, notify: () => {}, theme },
		} as unknown as ExtensionContext;
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);

		const monitorTool = tools.get("monitor");
		expect(monitorTool).toBeDefined();
		const description = "deploy check watch";
		await monitorTool?.execute("call_1", { description, command: "printf 'line\\n'" });

		const plainStatus = `◉ watching ${description} (0s)`;
		expect(setStatus).toHaveBeenCalledWith("monitors", theme.bg("selectedBg", theme.fg("text", plainStatus)));
		await cleared.promise;
		expect(setStatus).toHaveBeenCalledWith("monitors", undefined);

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	});
});
