import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTerminalExtension } from "../../../src/core/extensions/builtin/terminal/extension.ts";
import type { MonitorSnapshotEntry } from "../../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { MonitorStatusTicker } from "../../../src/core/extensions/builtin/terminal/monitor-status-ticker.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { RELOAD_STALE_MESSAGE, REPLACEMENT_STALE_MESSAGE, retirableContext } from "./2549-retirable-context-support.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type MonitorTool = { execute: (id: string, input: Record<string, unknown>) => Promise<{ isError?: boolean }> };

interface Generation {
	readonly statuses: Array<string | undefined>;
	readonly ctx: ReturnType<typeof retirableContext>;
	readonly monitor: MonitorTool;
	emit(eventType: string, payload: Record<string, unknown>, ctx?: ExtensionContext): Promise<void>;
}

const T0 = 1_000_000;
const entry: MonitorSnapshotEntry = { id: "bash_1", description: "deploy errors", paused: false, startedAtMs: T0 };

describe("#2549 MonitorStatusTicker vs a retired extension context", () => {
	afterEach(() => vi.useRealTimers());

	it.each([
		["reload", RELOAD_STALE_MESSAGE],
		["replacement", REPLACEMENT_STALE_MESSAGE],
	])("retires instead of throwing when a %s retires the render context", (_label, message) => {
		vi.useFakeTimers();
		let now = T0;
		let renders = 0;
		const ticker = new MonitorStatusTicker({
			now: () => now,
			render: () => {
				renders += 1;
				if (renders > 1) throw new Error(message);
			},
		});
		ticker.sync([entry]);
		expect(ticker.running).toBe(true);

		now += 1_000;
		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		expect(ticker.running).toBe(false);
		now += 5_000;
		vi.advanceTimersByTime(5_000);
		expect(renders).toBe(2);
	});

	it("re-arms on the next sync once a live context renders again", () => {
		vi.useFakeTimers();
		let now = T0;
		let stale = false;
		const labels: Array<string | undefined> = [];
		const ticker = new MonitorStatusTicker({
			now: () => now,
			render: (status) => {
				if (stale) throw new Error(RELOAD_STALE_MESSAGE);
				labels.push(status);
			},
		});
		ticker.sync([entry]);
		stale = true;
		now += 1_000;
		vi.advanceTimersByTime(1_000);
		expect(ticker.running).toBe(false);

		stale = false;
		ticker.sync([entry]);
		now += 1_000;
		vi.advanceTimersByTime(1_000);

		expect(ticker.running).toBe(true);
		expect(labels).toEqual([
			"◉ watching deploy errors (0s)",
			"◉ watching deploy errors (1s)",
			"◉ watching deploy errors (2s)",
		]);
	});

	it("does not re-arm a sync whose immediate render hit the retired context", () => {
		vi.useFakeTimers();
		const ticker = new MonitorStatusTicker({
			now: () => T0,
			render: () => {
				throw new Error(REPLACEMENT_STALE_MESSAGE);
			},
		});

		expect(() => ticker.sync([entry])).not.toThrow();
		expect(ticker.running).toBe(false);
	});

	it("still surfaces a render failure that is not a retired context", () => {
		vi.useFakeTimers();
		let now = T0;
		let renders = 0;
		const ticker = new MonitorStatusTicker({
			now: () => now,
			render: () => {
				renders += 1;
				if (renders > 1) throw new Error("disk exploded");
			},
		});
		ticker.sync([entry]);

		now += 1_000;
		expect(() => vi.advanceTimersByTime(1_000)).toThrow("disk exploded");
	});
});

describe("#2549 terminal extension footer across a retired session", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let live: Generation[] = [];

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-2549-terminal-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		writeFileSync(join(cwd, ".senpi", "settings.json"), JSON.stringify({ terminal: { notify: "off" } }));
		live = [];
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		vi.setSystemTime(T0);
	});

	afterEach(async () => {
		vi.useRealTimers();
		for (const generation of live) {
			generation.ctx.revive();
			await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	async function startGeneration(sessionId: string, reason: string): Promise<Generation> {
		const handlers = new Map<string, Handler[]>();
		const tools = new Map<string, MonitorTool>();
		const statuses: Array<string | undefined> = [];
		let activeTools: string[] = [];
		const pi = {
			registerTool: (tool: MonitorTool & { name: string }) => tools.set(tool.name, tool),
			registerMessageRenderer: () => {},
			on: (eventType: string, handler: Handler) =>
				handlers.set(eventType, [...(handlers.get(eventType) ?? []), handler]),
			sendMessage: () => {},
			sendUserMessage: () => {},
			getActiveTools: () => activeTools,
			setActiveTools: (next: string[]) => {
				activeTools = next;
			},
		} as unknown as ExtensionAPI;
		registerTerminalExtension(pi);
		const ctx = retirableContext({
			cwd,
			sessionId,
			ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text), notify: () => {}, theme },
		});
		const monitor = tools.get("monitor");
		if (!monitor) throw new Error("monitor tool was not registered");
		const generation: Generation = {
			statuses,
			ctx,
			monitor,
			async emit(eventType, payload, handlerCtx = ctx.context) {
				for (const handler of handlers.get(eventType) ?? []) await handler(payload, handlerCtx);
			},
		};
		await generation.emit("session_start", { type: "session_start", reason });
		live.push(generation);
		return generation;
	}

	async function watch(generation: Generation, description: string): Promise<void> {
		const started = await generation.monitor.execute(description, { description, command: "cat", persistent: true });
		expect(started.isError).toBeFalsy();
	}

	// A reload shuts the old generation down and the new one claims its parked monitors.
	// A replacement here is a session disposed without session_shutdown (as app-server
	// thread unload does), so its ticker is still armed when the context retires.
	it.each([
		{ label: "reload", message: RELOAD_STALE_MESSAGE, reason: "reload", nextSession: "session-a" },
		{ label: "new session", message: REPLACEMENT_STALE_MESSAGE, reason: "new", nextSession: "session-b" },
		{ label: "fork", message: REPLACEMENT_STALE_MESSAGE, reason: "fork", nextSession: "session-c" },
	])(
		"survives a $label while a monitor ticks and renders it on the next session",
		async ({ message, reason, nextSession }) => {
			const first = await startGeneration("session-a", "startup");
			await watch(first, "build watch");
			expect(first.statuses.at(-1)).toContain("build watch");

			first.ctx.retire(message);
			vi.advanceTimersByTime(1_000);
			const rendersOnRetired = first.statuses.length;
			expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
			expect(first.statuses).toHaveLength(rendersOnRetired);

			if (reason === "reload") {
				await first.emit("session_shutdown", { type: "session_shutdown", reason }, first.ctx.successor);
				live = live.filter((generation) => generation !== first);
			}
			const next = await startGeneration(nextSession, reason);
			if (reason !== "reload") await watch(next, "build watch");
			expect(next.statuses.at(-1)).toMatch(/watching build watch \(\d+s\)/);

			const before = next.statuses.at(-1);
			vi.advanceTimersByTime(1_000);
			expect(next.statuses.at(-1)).not.toBe(before);
			expect(next.statuses.at(-1)).toContain("build watch");
		},
	);
});
