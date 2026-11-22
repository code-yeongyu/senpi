import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventBus } from "../../src/core/event-bus.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import configReloadExtension, {
	type ConfigReloadExtensionOptions,
} from "../../src/core/extensions/builtin/config-reload/index.ts";
import type { ConfigReloadLogger } from "../../src/core/extensions/builtin/config-reload/log.ts";
import { CONFIG_WATCH_REGISTER } from "../../src/core/extensions/builtin/config-reload/protocol.ts";
import type { WatchEventListener } from "../../src/core/extensions/builtin/config-reload/watch-engine.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";

type RecordedHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type Generation = { readonly api: ExtensionAPI; readonly handlers: Map<string, RecordedHandler[]> };
type LoggedEvent = { readonly level: string; readonly event: string; readonly details: unknown };

const directories: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value)}\n`, "utf-8");
}

function watchProbe(): {
	subscribe: ConfigReloadExtensionOptions["subscribe"];
	emit(path: string, file: string): void;
} {
	const listeners = new Map<string, Set<WatchEventListener>>();
	return {
		subscribe: (path, listener) => {
			const set = listeners.get(path) ?? new Set<WatchEventListener>();
			set.add(listener);
			listeners.set(path, set);
			return () => {
				set.delete(listener);
			};
		},
		emit: (path, file) => {
			for (const listener of listeners.get(path) ?? []) listener("change", file);
		},
	};
}

function generation(bus: EventBus): Generation {
	const handlers = new Map<string, RecordedHandler[]>();
	const api = {
		events: bus,
		on: (event: string, handler: RecordedHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

async function invoke(target: Generation, event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
	for (const handler of target.handlers.get(event) ?? []) await handler(payload, ctx);
}

function context(
	cwd: string,
	requestReload: () => Promise<void>,
	checkReloadVeto?: () => Promise<{ cancelled: boolean; reason?: string }>,
): ExtensionContext {
	return {
		checkReloadVeto,
		cwd,
		mode: "tui",
		ui: { notify: () => {} } as unknown as ExtensionUIContext,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		isCompacting: () => false,
		requestReload,
	} as unknown as ExtensionContext;
}

function recordingLogger(events: LoggedEvent[]): ConfigReloadLogger {
	const record = (level: string) => (event: string, details: unknown) => {
		events.push({ level, event, details });
		return { written: true, disabled: false };
	};
	return {
		debug: record("debug"),
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
	} as unknown as ConfigReloadLogger;
}

async function settle(ms = 200): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await Promise.resolve();
	await Promise.resolve();
}

/**
 * Drives real reload generations: each requestReload shuts the current generation down, starts a
 * fresh config-reload instance with session_start(reason: "reload"), and only THEN re-emits the
 * extension's watch registration, the order a live session uses (#2878).
 */
function reloadChain(options: {
	readonly agentDir: string;
	readonly registration?: () => unknown;
	readonly beforeRestart?: (reloadIndex: number) => void | Promise<void>;
	readonly hashFile?: (path: string) => string;
	readonly maxGenerations: number;
}): { readonly reloads: number[]; readonly logs: LoggedEvent[]; start(): Promise<void>; bus: EventBus } {
	const bus = createEventBus();
	const watches = watchProbe();
	const reloads: number[] = [];
	const logs: LoggedEvent[] = [];
	const extensionOptions = (): ConfigReloadExtensionOptions => ({
		agentDir: options.agentDir,
		subscribe: watches.subscribe,
		logger: recordingLogger(logs),
		...(options.hashFile ? { hashFile: options.hashFile } : {}),
	});
	const startGeneration = async (reason: "startup" | "reload"): Promise<void> => {
		const current = generation(bus);
		configReloadExtension(current.api, extensionOptions());
		const ctx = context(options.agentDir, async () => {
			const index = reloads.length;
			reloads.push(index);
			await invoke(
				current,
				"session_shutdown",
				{ type: "session_shutdown", reason: "reload" } satisfies SessionShutdownEvent,
				ctx,
			);
			if (reloads.length >= options.maxGenerations) return;
			await options.beforeRestart?.(index);
			await startGeneration("reload");
		});
		await invoke(current, "session_start", { type: "session_start", reason } satisfies SessionStartEvent, ctx);
		const registration = options.registration?.();
		if (registration) bus.emit(CONFIG_WATCH_REGISTER, registration);
	};
	return {
		reloads,
		logs,
		bus,
		start: async () => {
			await startGeneration("startup");
			writeJson(join(options.agentDir, "settings.json"), { theme: "first-change" });
			watches.emit(options.agentDir, "settings.json");
			await settle();
			await settle(5_000);
		},
	};
}

describe("config-reload post-reload handoff (#2878)", () => {
	it("does not reload again for an unchanged file only an extension watches", async () => {
		// given an extension that watches its own config file and re-registers after session_start
		vi.useFakeTimers();
		const agentDir = tempDir("senpi-2878-agent-");
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		const extensionConfig = join(tempDir("senpi-2878-ext-"), "omo.jsonc");
		writeJson(extensionConfig, { quick: "luna" });
		const chain = reloadChain({
			agentDir,
			registration: () => ({ id: "omo", displayName: "omo", targets: [{ path: extensionConfig, kind: "file" }] }),
			maxGenerations: 6,
		});

		// when a real settings change reloads the session once
		await chain.start();

		// then the untouched extension file does not start another reload
		expect(chain.reloads).toHaveLength(1);
	});

	it("still reloads once when the extension file really changed during the reload", async () => {
		// given the extension's file is edited while the first reload runs
		vi.useFakeTimers();
		const agentDir = tempDir("senpi-2878-agent-");
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		const extensionConfig = join(tempDir("senpi-2878-ext-"), "omo.jsonc");
		writeJson(extensionConfig, { quick: "luna" });
		const chain = reloadChain({
			agentDir,
			registration: () => ({ id: "omo", displayName: "omo", targets: [{ path: extensionConfig, kind: "file" }] }),
			beforeRestart: (index) => {
				if (index === 0) writeJson(extensionConfig, { quick: "haiku" });
			},
			maxGenerations: 6,
		});

		// when the session reloads for the settings change
		await chain.start();

		// then the edited extension file triggers exactly one more reload
		expect(chain.reloads).toHaveLength(2);
	});

	it("backs off the veto recheck while children keep running and logs one deferral", async () => {
		// given a reload that stays vetoed by running subagents for a minute
		vi.useFakeTimers();
		const agentDir = tempDir("senpi-2878-veto-");
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		const bus = createEventBus();
		const watches = watchProbe();
		const logs: LoggedEvent[] = [];
		const checkReloadVeto = vi.fn(async () => ({
			cancelled: true,
			reason: "4 subagent(s) still running: a, b, c, d",
		}));
		const requestReload = vi.fn(async () => {});
		const current = generation(bus);
		configReloadExtension(current.api, { agentDir, subscribe: watches.subscribe, logger: recordingLogger(logs) });
		await invoke(
			current,
			"session_start",
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			context(agentDir, requestReload, checkReloadVeto),
		);

		// when a settings change waits behind the veto for 60 s
		writeJson(join(agentDir, "settings.json"), { theme: "light" });
		watches.emit(agentDir, "settings.json");
		await settle();
		await settle(60_000);

		// then the recheck backs off instead of polling every second, and the reason is logged once
		expect(requestReload).not.toHaveBeenCalled();
		expect(checkReloadVeto.mock.calls.length).toBeLessThanOrEqual(12);
		expect(logs.filter((entry) => entry.event === "reload_deferred")).toHaveLength(1);
	});

	it("stops a handoff-only reload chain even when each reload takes longer than a minute", async () => {
		// given a watched file whose hash differs on every read and reloads that each take 70 s
		vi.useFakeTimers();
		const agentDir = tempDir("senpi-2878-slow-");
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		let reads = 0;
		const chain = reloadChain({
			agentDir,
			hashFile: (path) => (path.endsWith("settings.json") ? `flip-${reads++}` : `stable-${path}`),
			beforeRestart: () => {
				vi.setSystemTime(Date.now() + 70_000);
			},
			maxGenerations: 10,
		});

		// when the session starts reloading
		await chain.start();

		// then slow cycles still stop the chain and say why
		expect(chain.reloads.length).toBeLessThanOrEqual(4);
		expect(chain.logs.some((entry) => entry.level === "warn" && entry.event === "reload_loop_stopped")).toBe(true);
	});

	it("stops a handoff-only reload chain and logs reload_loop_stopped", async () => {
		// given a watched file whose hash differs on every read, so every handoff reports a change
		vi.useFakeTimers();
		const agentDir = tempDir("senpi-2878-agent-");
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		let reads = 0;
		const chain = reloadChain({
			agentDir,
			hashFile: (path) => (path.endsWith("settings.json") ? `flip-${reads++}` : `stable-${path}`),
			maxGenerations: 10,
		});

		// when the session starts reloading
		await chain.start();

		// then the chain stops well short of the generation cap and says why
		expect(chain.reloads.length).toBeLessThanOrEqual(4);
		expect(chain.logs.some((entry) => entry.level === "warn" && entry.event === "reload_loop_stopped")).toBe(true);
	});
});
