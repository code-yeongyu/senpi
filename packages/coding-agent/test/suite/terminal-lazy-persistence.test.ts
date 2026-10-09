import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_MONITOR_ENDED_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const removals = vi.hoisted(() => ({
	started: [] as Array<{ monitorId: string; done: Promise<void> }>,
	listeners: new Set<(entry: { monitorId: string; done: Promise<void> }) => void>(),
}));

vi.mock("../../src/core/extensions/builtin/terminal/monitor-state-dir.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/core/extensions/builtin/terminal/monitor-state-dir.ts")>();
	return {
		...original,
		removeMonitorStateDir: (terminalDir: string, monitorId: string) => {
			const done = original.removeMonitorStateDir(terminalDir, monitorId);
			const entry = { monitorId, done };
			removals.started.push(entry);
			for (const listener of removals.listeners) listener(entry);
			return done;
		},
	};
});

/** Resolves with the monitor id once the product's removal of that monitor's state dir has finished. */
function removalFor(monitorId: string): Promise<string> {
	const started = removals.started.find((entry) => entry.monitorId === monitorId);
	if (started) return started.done.then(() => monitorId);
	return new Promise((resolve, reject) => {
		const listener = (entry: { monitorId: string; done: Promise<void> }) => {
			if (entry.monitorId !== monitorId) return;
			removals.listeners.delete(listener);
			entry.done.then(() => resolve(monitorId), reject);
		};
		removals.listeners.add(listener);
	});
}

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: { bash_id?: string; monitor_id?: string };
}

interface ToolLike {
	name: string;
	execute: (id: string, input: Record<string, unknown>) => Promise<ToolResultLike>;
}

interface Generation {
	readonly tools: Map<string, ToolLike>;
	readonly emit: (eventType: string, payload: Record<string, unknown>) => Promise<void>;
	readonly onMonitorEnded: (listener: (event: { id: string; reason: string }) => void) => () => void;
}

function createGeneration(cwd: string, sessionId: string, sessionDir: string): Generation {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolLike>();
	const endedListeners = new Set<(event: { id: string; reason: string }) => void>();
	let activeTools: string[] = [];
	const pi = {
		registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
		registerMessageRenderer: () => {},
		events: {
			emit: (type: string, event: { id: string; reason: string }) => {
				if (type !== TERMINAL_MONITOR_ENDED_EVENT) return;
				for (const listener of endedListeners) listener(event);
			},
		},
		on: (eventType: string, handler: Handler) => {
			handlers.set(eventType, [...(handlers.get(eventType) ?? []), handler]);
		},
		sendMessage: () => {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		mode: "tui",
		model: { id: "test-model", api: "openai-completions" },
		ui: { setStatus: () => {}, notify: () => {}, theme },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`),
			getSessionDir: () => sessionDir,
		},
	} as unknown as ExtensionContext;
	registerTerminalExtension(pi);
	return {
		tools,
		async emit(eventType, payload) {
			for (const handler of handlers.get(eventType) ?? []) await handler(payload, ctx);
		},
		onMonitorEnded(listener) {
			endedListeners.add(listener);
			return () => endedListeners.delete(listener);
		},
	};
}

function manifestOf(
	stateDir: string,
	sessionId: string,
): { monitors: Array<{ description: string; suspended: boolean }> } {
	return JSON.parse(readFileSync(join(stateDir, `${sessionId}.json`), "utf8"));
}

describe("terminal persistence is lazy and survives a reload", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let sessionDir: string;
	let stateDir: string;
	let sessionId: string;
	let counter = 0;
	let live: Generation[] = [];

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-lazy-persist-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		sessionDir = join(tmp, "sessions");
		stateDir = join(sessionDir, "extensions", "terminal");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		sessionId = `lazy-${Date.now().toString(36)}-${++counter}`;
		live = [];
	});

	afterEach(async () => {
		for (const generation of live) {
			await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	async function start(reason: string): Promise<Generation> {
		const generation = createGeneration(cwd, sessionId, sessionDir);
		live.push(generation);
		await generation.emit("session_start", { type: "session_start", reason });
		return generation;
	}

	async function createPersistent(generation: Generation, description: string): Promise<ToolResultLike> {
		const monitor = generation.tools.get("monitor");
		if (!monitor) throw new Error("monitor tool missing");
		return monitor.execute(`create-${description}`, { description, command: "cat", persistent: true });
	}

	it("a session that never registers anything leaves no terminal state files at all", async () => {
		const generation = await start("startup");
		expect(existsSync(stateDir)).toBe(false);
		await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		live = [];
		expect(existsSync(stateDir)).toBe(false);
	});

	it("the first persistent monitor creates the lease and the manifest together", async () => {
		const generation = await start("startup");
		expect(existsSync(stateDir)).toBe(false);
		const result = await createPersistent(generation, "first watch");
		expect(result.isError).not.toBe(true);
		expect(readdirSync(stateDir).sort()).toEqual([`${sessionId}.json`, `${sessionId}.lease`, "state"]);
		expect(manifestOf(stateDir, sessionId).monitors.map((entry) => entry.description)).toEqual(["first watch"]);
	});

	it("kill_bash on a persistent watch removes its state dir; a process exit keeps it for the restore", async () => {
		const generation = await start("startup");
		const created = await createPersistent(generation, "state dir watch");
		const monitorId = String(created.details?.monitor_id);
		const dir = join(stateDir, "state", monitorId);
		expect(existsSync(dir)).toBe(true);
		const kill = generation.tools.get("kill_bash");
		if (!kill) throw new Error("kill_bash tool missing");
		await kill.execute("kill", { bash_id: monitorId });
		expect(existsSync(dir)).toBe(false);

		const survivor = await createPersistent(generation, "survivor watch");
		const survivorDir = join(stateDir, "state", String(survivor.details?.monitor_id));
		await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		live = [];
		expect(existsSync(survivorDir)).toBe(true);
	});

	it("a persistent watch whose command ends on its own loses its state dir once the end is observed", async () => {
		const generation = await start("startup");
		const monitor = generation.tools.get("monitor");
		if (!monitor) throw new Error("monitor tool missing");
		const trigger = join(stateDir, "..", "end-now");
		const created = await monitor.execute("create-self-ending", {
			description: "self-ending watch",
			command: `while [ ! -e '${trigger}' ]; do sleep 0.1; done; exit 3`,
			persistent: true,
		});
		const monitorId = String(created.details?.monitor_id);
		const dir = join(stateDir, "state", monitorId);
		expect(existsSync(dir)).toBe(true);
		// Wait on the product's own removal (its real rm, wrapped by the mock above), bounded: without
		// the removal this settles false and the test fails on the value, never on a timeout.
		removals.started.length = 0;
		const removal = removalFor(monitorId);
		writeFileSync(trigger, "");
		const removedMonitorId = await Promise.race([
			removal,
			new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10_000)),
		]);
		expect(removedMonitorId).toBe(monitorId);
		expect(existsSync(dir)).toBe(false);
	});

	it("a reload keeps the pre-reload durable entries when the next transition writes", async () => {
		const first = await start("startup");
		await createPersistent(first, "before reload");
		await first.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		live = [];
		const second = await start("reload");
		await createPersistent(second, "after reload");
		const descriptions = manifestOf(stateDir, sessionId)
			.monitors.map((entry) => entry.description)
			.sort();
		expect(descriptions).toEqual(["after reload", "before reload"]);
	});
});
