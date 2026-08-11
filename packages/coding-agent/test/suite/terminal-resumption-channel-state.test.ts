import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	WAKE_SOURCE_STATE_EVENT,
	type WakeSourceStateEvent,
} from "../../src/core/extensions/builtin/monitor-state-event.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type EventListener = (data: unknown) => void;

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

interface ToolLike {
	name: string;
	execute: (id: string, input: Record<string, unknown>) => Promise<ToolResultLike>;
}

interface LegacyMonitorStateEvent {
	readonly activeCount: number;
	readonly monitors: readonly unknown[];
}

interface FakeRunner {
	readonly pi: ExtensionAPI;
	readonly tools: Map<string, ToolLike>;
	readonly channelStates: WakeSourceStateEvent[];
	readonly legacyMonitorStates: LegacyMonitorStateEvent[];
	emitLifecycle(eventType: string, payload: Record<string, unknown>, ctx: ExtensionContext): Promise<void>;
	waitForChannel(source: string, activeCount: number): Promise<WakeSourceStateEvent>;
}

function isChannelState(data: unknown): data is WakeSourceStateEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		"source" in data &&
		typeof data.source === "string" &&
		"activeCount" in data &&
		typeof data.activeCount === "number"
	);
}

function createRunner(): FakeRunner {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolLike>();
	const eventListeners = new Map<string, Set<EventListener>>();
	const channelStates: WakeSourceStateEvent[] = [];
	const legacyMonitorStates: LegacyMonitorStateEvent[] = [];
	let activeTools: string[] = [];

	const events = {
		on(eventType: string, listener: EventListener) {
			const listeners = eventListeners.get(eventType) ?? new Set<EventListener>();
			listeners.add(listener);
			eventListeners.set(eventType, listeners);
			return () => listeners.delete(listener);
		},
		emit(eventType: string, data: unknown) {
			if (eventType === WAKE_SOURCE_STATE_EVENT && isChannelState(data)) channelStates.push(data);
			if (
				eventType === "terminal_monitor_state" &&
				typeof data === "object" &&
				data !== null &&
				"activeCount" in data &&
				typeof data.activeCount === "number" &&
				"monitors" in data &&
				Array.isArray(data.monitors)
			) {
				legacyMonitorStates.push({ activeCount: data.activeCount, monitors: data.monitors });
			}
			for (const listener of eventListeners.get(eventType) ?? []) listener(data);
		},
	};

	const pi = {
		registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
		on: (eventType: string, handler: Handler) => {
			const registered = handlers.get(eventType) ?? [];
			registered.push(handler);
			handlers.set(eventType, registered);
		},
		events,
		sendMessage: () => {},
		sendUserMessage: () => {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		tools,
		channelStates,
		legacyMonitorStates,
		async emitLifecycle(eventType, payload, ctx) {
			for (const handler of handlers.get(eventType) ?? []) await handler(payload, ctx);
		},
		waitForChannel(source, activeCount) {
			return new Promise<WakeSourceStateEvent>((resolve, reject) => {
				const timeout = setTimeout(() => {
					unsubscribe();
					reject(new Error(`Timed out waiting for ${source} activeCount=${activeCount}`));
				}, 5000);
				const unsubscribe = events.on(WAKE_SOURCE_STATE_EVENT, (data) => {
					if (!isChannelState(data) || data.source !== source || data.activeCount !== activeCount) return;
					clearTimeout(timeout);
					unsubscribe();
					resolve(data);
				});
			});
		},
	};
}

function firstText(result: ToolResultLike | undefined): string {
	return result?.content.find((block) => block.type === "text")?.text ?? "";
}

function extractBashId(result: ToolResultLike | undefined): string {
	const match = /ID: (bash_\d+)/.exec(firstText(result));
	if (!match?.[1]) throw new Error(`No bash id in tool result: ${firstText(result)}`);
	return match[1];
}

function makeContext(cwd: string, sessionId: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		model: { id: "test-model", api: "openai-completions" },
		ui: { setStatus: () => {}, notify: () => {}, theme },
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
}

describe("terminal wake source state", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let sessionCounter = 0;
	let live: Array<{ runner: FakeRunner; ctx: ExtensionContext }> = [];

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-terminal-channel-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		live = [];
	});

	afterEach(async () => {
		for (const generation of live) {
			await generation.runner.emitLifecycle(
				"session_shutdown",
				{ type: "session_shutdown", reason: "quit" },
				generation.ctx,
			);
		}
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	async function start(reason = "startup", notify: "wake" | "off" = "wake", sessionId?: string) {
		writeFileSync(join(cwd, ".senpi", "settings.json"), JSON.stringify({ terminal: { notify } }));
		const runner = createRunner();
		registerTerminalExtension(runner.pi);
		const ctx = makeContext(cwd, sessionId ?? `terminal-channel-${++sessionCounter}`);
		await runner.emitLifecycle("session_start", { type: "session_start", reason }, ctx);
		live.push({ runner, ctx });
		return { runner, ctx };
	}

	it("emits matching legacy and wake-source snapshots for monitor transitions", async () => {
		const { runner } = await start();
		const monitor = runner.tools.get("monitor");
		const started = await monitor?.execute("monitor", {
			description: "dual emit monitor",
			command: "cat",
			persistent: true,
		});
		const bashId = extractBashId(started);

		const legacy = runner.legacyMonitorStates.at(-1);
		const channel = runner.channelStates.filter((state) => state.source === "terminal-monitors").at(-1);
		expect(legacy?.activeCount).toBe(1);
		expect(channel).toEqual({
			source: "terminal-monitors",
			activeCount: legacy?.activeCount,
			monitors: [{ id: bashId, description: "dual emit monitor", startedAtMs: expect.any(Number) }],
		});
	});

	it("emits terminal-background-sessions snapshots on spawn, exit, and kill", async () => {
		const { runner } = await start();
		const bash = runner.tools.get("bash");
		const exited = await bash?.execute("quick", {
			command: "printf done",
			description: "quick background",
			run_in_background: true,
		});
		const exitedId = extractBashId(exited);
		expect(runner.channelStates).toContainEqual({
			source: "terminal-background-sessions",
			activeCount: 1,
			items: [{ id: exitedId, description: "quick background", startedAtMs: expect.any(Number) }],
		});
		expect(
			runner.channelStates.filter((state) => state.source === "terminal-background-sessions").at(-1)?.activeCount,
		).toBe(0);

		const started = await bash?.execute("long", {
			command: "cat",
			description: "kill background",
			run_in_background: true,
		});
		const bashId = extractBashId(started);
		expect(
			runner.channelStates.filter((state) => state.source === "terminal-background-sessions").at(-1)?.activeCount,
		).toBe(1);
		const killedState = runner.waitForChannel("terminal-background-sessions", 0);
		await runner.tools.get("kill_bash")?.execute("kill", { bash_id: bashId });
		expect(await killedState).toMatchObject({ source: "terminal-background-sessions", activeCount: 0, items: [] });
	});

	it("tracks two concurrent backgrounds and decrements when one exits", async () => {
		const { runner } = await start();
		const bash = runner.tools.get("bash");
		const first = extractBashId(
			await bash?.execute("first", { command: "read line", description: "first", run_in_background: true }),
		);
		const second = extractBashId(
			await bash?.execute("second", { command: "cat", description: "second", run_in_background: true }),
		);
		expect(
			runner.channelStates.filter((state) => state.source === "terminal-background-sessions").at(-1)?.activeCount,
		).toBe(2);

		const decremented = runner.waitForChannel("terminal-background-sessions", 1);
		await runner.tools.get("bash_input")?.execute("exit-first", { bash_id: first, input: "\n" });
		expect(await decremented).toMatchObject({
			source: "terminal-background-sessions",
			activeCount: 1,
			items: [{ id: second, description: "second", startedAtMs: expect.any(Number) }],
		});
	});

	it('counts background sessions even when terminal notify is "off"', async () => {
		const { runner } = await start("startup", "off");
		const started = await runner.tools.get("bash")?.execute("muted", {
			command: "cat",
			description: "muted background",
			run_in_background: true,
		});
		const bashId = extractBashId(started);
		expect(runner.channelStates.filter((state) => state.source === "terminal-background-sessions").at(-1)).toEqual({
			source: "terminal-background-sessions",
			activeCount: 1,
			items: [{ id: bashId, description: "muted background", startedAtMs: expect.any(Number) }],
		});
	});

	it("session_start re-emits both current source snapshots without a prior transition", async () => {
		const sessionId = `terminal-channel-reload-${++sessionCounter}`;
		const first = await start("startup", "wake", sessionId);
		await first.runner.tools.get("monitor")?.execute("monitor", {
			description: "reload monitor",
			command: "cat",
			persistent: true,
		});
		await first.runner.tools.get("bash")?.execute("bash", {
			command: "cat",
			description: "reload bash",
			run_in_background: true,
		});
		await first.runner.emitLifecycle("session_shutdown", { type: "session_shutdown", reason: "reload" }, first.ctx);
		live = [];

		const second = await start("reload", "wake", sessionId);
		expect(second.runner.channelStates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: "terminal-monitors", activeCount: 1 }),
				expect.objectContaining({ source: "terminal-background-sessions", activeCount: 1 }),
			]),
		);
	});
});
