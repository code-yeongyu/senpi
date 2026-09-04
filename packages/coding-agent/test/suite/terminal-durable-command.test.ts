import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRestartableCommandHandler } from "../../src/core/extensions/builtin/terminal/durable-command.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { type MonitorEvent, MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { restoreTerminalState } from "../../src/core/extensions/builtin/terminal/restore.ts";
import { DURABLE_MONITOR_EXPIRY_MS } from "../../src/core/extensions/builtin/terminal/shared.ts";
import {
	type ManifestMonitor,
	TerminalManifestWriter,
} from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import {
	bindTerminalManifestWriter,
	createMonitorTool,
	unbindTerminalManifestWriter,
} from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import type { SpawnRequest } from "../../src/core/extensions/builtin/terminal/tools/spawn.ts";
import { spawnCommandSession } from "../../src/core/extensions/builtin/terminal/tools/spawn.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const spawnTracker = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/core/extensions/builtin/terminal/tools/spawn.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/core/extensions/builtin/terminal/tools/spawn.ts")>();
	return {
		...original,
		spawnCommandSession: (...args: Parameters<typeof original.spawnCommandSession>) => {
			spawnTracker.calls += 1;
			return original.spawnCommandSession(...args);
		},
	};
});

class EventSink {
	readonly events: MonitorEvent[] = [];
	readonly #listeners = new Set<(event: MonitorEvent) => void>();

	push(event: MonitorEvent): void {
		this.events.push(event);
		for (const listener of this.#listeners) listener(event);
	}

	lines(): string[] {
		return this.events.flatMap((event) => (event.type === "line" ? [event.line] : []));
	}

	waitFor(predicate: (event: MonitorEvent) => boolean, label: string): Promise<MonitorEvent> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#listeners.delete(listener);
				reject(new Error(`Timed out waiting for ${label}`));
			}, 5000);
			const listener = (event: MonitorEvent) => {
				if (!predicate(event)) return;
				clearTimeout(timeout);
				this.#listeners.delete(listener);
				resolve(event);
			};
			this.#listeners.add(listener);
			for (const event of this.events) listener(event);
		});
	}
}

function manifestMonitor(overrides: Partial<ManifestMonitor> & Pick<ManifestMonitor, "monitorId">): ManifestMonitor {
	return {
		sessionId: "durable-session",
		description: "restartable watch",
		runtimeKind: "command",
		durabilityClass: "restartable-command",
		command: "cat",
		createdAt: 1,
		expiresAt: null,
		persistent: true,
		suspended: true,
		lastCheckpoint: null,
		deliveryPaused: false,
		wakeCount: 0,
		fireWindow: { startMs: 1, count: 0 },
		...overrides,
	};
}

describe("restartable-command durability class", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	let tmp: string;
	let sessionDir: string;
	let workDir: string;
	let sessionId: string;
	let manager: TerminalManager;
	let registry: MonitorRegistry;
	let sink: EventSink;
	let ctx: TerminalToolContext;
	let writer: TerminalManifestWriter;
	let sessionSeq = 0;

	beforeEach(async () => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		spawnTracker.calls = 0;
		tmp = await mkdtemp(join(tmpdir(), "senpi-durable-command-"));
		sessionDir = join(tmp, "session");
		workDir = join(tmp, "work");
		sessionId = `durable-command-${process.pid}-${++sessionSeq}`;
		manager = new TerminalManager();
		sink = new EventSink();
		registry = new MonitorRegistry((event) => sink.push(event));
		ctx = {
			manager,
			cwd: workDir,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			monitorRegistry: registry,
			onMonitorEvent: (event) => sink.push(event),
			getSessionContext: () =>
				({
					sessionManager: { getSessionId: () => sessionId, getSessionDir: () => sessionDir },
				}) as unknown as ExtensionContext,
		};
		writer = new TerminalManifestWriter({
			session: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
		});
		expect(isAbsolute(writer.store.filePath)).toBe(true);
	});

	afterEach(async () => {
		registry.dispose();
		await manager.teardown();
		unbindTerminalManifestWriter(sessionId);
		await rm(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	async function restore(monitor: ManifestMonitor) {
		await writer.store.write({
			version: 1,
			sessionId,
			monitors: [monitor],
			backgroundSessions: [],
			updatedAt: 2,
		});
		const handler = createRestartableCommandHandler({ ctx, registry });
		return await restoreTerminalState({ manifest: writer.store, handlers: { "restartable-command": handler } });
	}

	it("(a) persists command, absolute cwd, filter and expiresAt for a persistent command monitor", async () => {
		await mkdir(workDir, { recursive: true });
		bindTerminalManifestWriter(sessionId, writer);
		const before = Date.now();
		// No execCtx cwd: the branch must fall back to the tool context cwd and persist it absolute.
		const result = await createMonitorTool(ctx).execute("durable-create", {
			description: "tail the log",
			command: "cat",
			filter: "^READY$",
			persistent: true,
		});
		await writer.flush();
		const entry = (await writer.store.read())?.monitors[0];
		expect(entry?.monitorId).toBe(result.details?.monitor_id);
		expect(entry?.durabilityClass).toBe("restartable-command");
		expect(entry?.command).toBe("cat");
		expect(entry?.filter).toBe("^READY$");
		expect(entry?.expiresAt).not.toBe(null);
		expect(entry?.expiresAt ?? 0).toBeGreaterThanOrEqual(before + DURABLE_MONITOR_EXPIRY_MS);
		expect(entry?.cwd !== undefined && isAbsolute(entry.cwd)).toBe(true);
		expect(entry?.cwd).toBe(workDir);
	});

	it("(b) records a non-persistent command monitor as ephemeral, never as restartable-command", async () => {
		await mkdir(workDir, { recursive: true });
		bindTerminalManifestWriter(sessionId, writer);
		await createMonitorTool(ctx).execute("durable-ephemeral", {
			description: "short watch",
			command: "cat",
			timeout_ms: 60_000,
		});
		await writer.flush();
		const entry = (await writer.store.read())?.monitors[0];
		expect(entry?.durabilityClass).toBe("ephemeral");
		expect(entry?.persistent).toBe(false);
	});

	it("(c) restores by spawning exactly once with the saved command and cwd, keeping the mon_ id", async () => {
		await mkdir(workDir, { recursive: true });
		const marker = join(workDir, "restored-marker");
		const monitorId = "mon_DURABLE0000000A";
		const digest = await restore(
			manifestMonitor({
				monitorId,
				command: `sh -c 'printf "restored-here\\n"; while [ ! -e "${marker}" ]; do sleep 0.05; done'`,
				cwd: workDir,
			}),
		);

		expect(digest).toEqual({ restored: 1, lost: 0, expired: 0, muted: 0, attachedElsewhere: 0, storeError: false });
		expect(spawnTracker.calls).toBe(1);
		await sink.waitFor((event) => event.type === "line" && event.line === "restored-here", "restored PTY line");
		const snapshot = registry.snapshot();
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]?.monitorId).toBe(monitorId);
		expect(snapshot[0]?.id).toMatch(/^bash_\d+$/);
		expect(manager.resolveId(monitorId)).toBe(snapshot[0]?.id);
		expect(sink.lines()).not.toContain("");
	});

	it("(d) never replays output the pre-restart runtime produced before shutdown", async () => {
		await mkdir(workDir, { recursive: true });
		const monitorId = "mon_DURABLE0000000B";
		const oldSpawn = await spawnCommandSession(ctx, {
			command: "sh -c 'printf \"pre-restart-marker\\n\"; sleep 30'",
			cols: 120,
			rows: 40,
			cwd: workDir,
		});
		registry.register({ id: oldSpawn.id, monitorId, description: "restartable watch", runtime: oldSpawn.runtime });
		manager.bindMonitorId(monitorId, oldSpawn.id);
		await sink.waitFor(
			(event) => event.type === "line" && event.line === "pre-restart-marker",
			"pre-restart marker line",
		);
		const oldRuntimeId = oldSpawn.id;
		// The pre-restart runtime deliberately stays resident and still bound to the mon_ id:
		// a handler that re-adopted it instead of spawning would replay its buffered marker.
		registry.dispose();
		sink.events.length = 0;
		spawnTracker.calls = 0;
		registry = new MonitorRegistry((event) => sink.push(event));

		const digest = await restore(
			manifestMonitor({ monitorId, command: "sh -c 'printf \"post-restart\\n\"; sleep 30'", cwd: workDir }),
		);

		// The registry replays a freshly registered runtime's buffered output synchronously
		// inside register(), so a re-adopted old runtime would have delivered its marker by now.
		expect(sink.lines()).not.toContain("pre-restart-marker");
		expect(digest.restored).toBe(1);
		expect(spawnTracker.calls).toBe(1);
		await sink.waitFor((event) => event.type === "line" && event.line === "post-restart", "post-restart line");
		expect(sink.lines()).not.toContain("pre-restart-marker");
		expect(registry.snapshot()[0]?.monitorId).toBe(monitorId);
		expect(registry.snapshot()[0]?.id).not.toBe(oldRuntimeId);
	});

	it("(e) reports lost without spawning when the saved cwd no longer exists", async () => {
		const digest = await restore(
			manifestMonitor({ monitorId: "mon_DURABLE0000000C", cwd: join(tmp, "vanished-dir") }),
		);

		expect(digest).toEqual({ restored: 0, lost: 1, expired: 0, muted: 0, attachedElsewhere: 0, storeError: false });
		expect(spawnTracker.calls).toBe(0);
		expect(registry.snapshot()).toEqual([]);
	});

	it("(f) reports lost without spawning for a non-persistent command entry", async () => {
		await mkdir(workDir, { recursive: true });
		const digest = await restore(
			manifestMonitor({ monitorId: "mon_DURABLE0000000D", cwd: workDir, persistent: false }),
		);

		expect(digest).toEqual({ restored: 0, lost: 1, expired: 0, muted: 0, attachedElsewhere: 0, storeError: false });
		expect(spawnTracker.calls).toBe(0);
		expect(registry.snapshot()).toEqual([]);
	});

	it("(g) re-applies a persisted mute by the FRESH runtime id and reports muted", async () => {
		await mkdir(workDir, { recursive: true });
		const monitorId = "mon_DURABLE0000000F";

		const digest = await restore(manifestMonitor({ monitorId, command: "cat", cwd: workDir, deliveryPaused: true }));

		expect(digest).toEqual({ restored: 0, lost: 0, expired: 0, muted: 1, attachedElsewhere: 0, storeError: false });
		expect(spawnTracker.calls).toBe(1);
		const snapshot = registry.snapshot();
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]?.monitorId).toBe(monitorId);
		expect(snapshot[0]?.paused).toBe(true);
	});

	it("(h) spawns the restored session with no timeout so a persistent watch is never killed", async () => {
		await mkdir(workDir, { recursive: true });
		const requests: SpawnRequest[] = [];
		const handler = createRestartableCommandHandler({
			ctx,
			registry,
			spawn: async (spawnCtx, request) => {
				requests.push(request);
				return await spawnCommandSession(spawnCtx, request);
			},
		});

		const outcome = await handler(
			manifestMonitor({ monitorId: "mon_DURABLE0000000E", command: "cat", cwd: workDir, filter: "^READY$" }),
		);

		expect(outcome).toEqual({ outcome: "restored" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.command).toBe("cat");
		expect(requests[0]?.cwd).toBe(workDir);
		expect(requests[0]?.timeoutMs).toBeUndefined();
	});
});

interface ToolLike {
	execute: (
		id: string,
		input: Record<string, unknown>,
	) => Promise<{
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
		details?: { bash_id?: string; monitor_id?: string };
	}>;
}

function firstText(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	return result?.content?.find((block) => block.type === "text")?.text ?? "";
}

describe("restartable-command durability class — reload", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let sessionDir: string;
	let sessionId: string;
	let live: Array<{ emit: (type: string, payload: Record<string, unknown>) => Promise<void> }> = [];
	let counter = 0;

	beforeEach(async () => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = await mkdtemp(join(tmpdir(), "senpi-durable-reload-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		sessionDir = join(tmp, "sessions");
		await mkdir(cwd, { recursive: true });
		sessionId = `durable-reload-${Date.now().toString(36)}-${++counter}`;
		live = [];
		spawnTracker.calls = 0;
	});

	afterEach(async () => {
		for (const generation of live) await generation.emit("session_shutdown", { reason: "quit" });
		await rm(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	function createGeneration() {
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>();
		const tools = new Map<string, ToolLike>();
		let activeTools: string[] = [];
		const pi = {
			registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
			on: (eventType: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
				handlers.set(eventType, [...(handlers.get(eventType) ?? []), handler]);
			},
			sendMessage: () => {},
			sendUserMessage: () => {},
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
		const generation = {
			tools,
			async emit(eventType: string, payload: Record<string, unknown>) {
				for (const handler of handlers.get(eventType) ?? []) await handler({ type: eventType, ...payload }, ctx);
			},
		};
		registerTerminalExtension(pi);
		live.push(generation);
		return generation;
	}

	it("(i) a reload re-start spawns nothing: the parked bundle keeps the same runtime session", async () => {
		const gen1 = createGeneration();
		await gen1.emit("session_start", { reason: "startup" });
		const created = await gen1.tools.get("monitor")?.execute("reload-monitor", {
			description: "reload watch",
			command: "sh -c 'printf \"before-reload-marker\\n\"; cat'",
			persistent: true,
		});
		expect(created?.isError).toBeFalsy();
		const runtimeId = created?.details?.bash_id;
		const monitorId = created?.details?.monitor_id;
		expect(runtimeId).toMatch(/^bash_\d+$/);
		const spawnsAfterCreate = spawnTracker.calls;
		expect(spawnsAfterCreate).toBe(1);

		await gen1.emit("session_shutdown", { reason: "reload" });
		live = [];
		const gen2 = createGeneration();
		await gen2.emit("session_start", { reason: "reload" });

		expect(spawnTracker.calls).toBe(spawnsAfterCreate);
		// The parked bundle kept the SAME PTY: its pre-reload output is still readable through
		// the stable mon_ id. A reload that re-spawned would hand back an empty fresh session.
		const peeked = await gen2.tools.get("bash_output")?.execute("peek", { bash_id: monitorId, view: "screen" });
		expect(peeked?.isError).toBeFalsy();
		await expect
			.poll(
				async () =>
					firstText(
						await gen2.tools.get("bash_output")?.execute("peek-again", { bash_id: monitorId, view: "screen" }),
					),
				{ timeout: 5000 },
			)
			.toContain("before-reload-marker");
	});
});
