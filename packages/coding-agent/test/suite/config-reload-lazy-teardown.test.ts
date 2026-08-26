import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import configReloadExtension from "../../src/core/extensions/builtin/config-reload/index.ts";
import type { ConfigReloadLogger } from "../../src/core/extensions/builtin/config-reload/log.ts";
import {
	ConfigReloadWatchEngine,
	type WatchEventListener,
} from "../../src/core/extensions/builtin/config-reload/watch-engine.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";

type RecordedHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

type ManualExtension = {
	readonly api: ExtensionAPI;
	readonly handlers: Map<string, RecordedHandler[]>;
};

/**
 * A subscribe seam whose unsubscribes are slow: each one records the teardown
 * marker observed at the moment it runs, so a test can prove close() returned
 * before the loop drained.
 */
type SlowTeardownProbe = {
	readonly subscribe: (
		path: string,
		listener: WatchEventListener,
		options?: { readonly recursive: boolean },
	) => () => void;
	/** Marker value each unsubscribe saw when it ran. */
	readonly unsubscribeMarkers: string[];
	marker: string;
	emit(path: string, filename: string | null): void;
	activeListenerCount(path: string): number;
};

function createSlowTeardownProbe(): SlowTeardownProbe {
	const listeners = new Map<string, Set<WatchEventListener>>();
	const probe: SlowTeardownProbe = {
		marker: "before-close",
		unsubscribeMarkers: [],
		subscribe: (path, listener) => {
			const set = listeners.get(path) ?? new Set<WatchEventListener>();
			set.add(listener);
			listeners.set(path, set);
			return () => {
				probe.unsubscribeMarkers.push(probe.marker);
				set.delete(listener);
			};
		},
		emit: (path, filename) => {
			for (const listener of [...(listeners.get(path) ?? [])]) listener("change", filename);
		},
		activeListenerCount: (path) => listeners.get(path)?.size ?? 0,
	};
	return probe;
}

function createManualExtension(): ManualExtension {
	const handlers = new Map<string, RecordedHandler[]>();
	const api = {
		events: createEventBus(),
		on: (event: string, handler: RecordedHandler) => {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

async function invoke(
	handlers: ReadonlyMap<string, readonly RecordedHandler[]>,
	eventName: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	const handler = handlers.get(eventName)?.at(-1);
	if (!handler) throw new Error(`Missing ${eventName} handler`);
	await handler(event, ctx);
}

function fakeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		ui: { notify: () => {} } as unknown as ExtensionUIContext,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		isCompacting: () => false,
	} as unknown as ExtensionContext;
}

function silentLogger(): ConfigReloadLogger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as ConfigReloadLogger;
}

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("config reload watcher teardown is non-blocking", () => {
	it("returns from close() before the unsubscribe loop runs", async () => {
		// Given: an engine watching several directories through a probe that
		// records the teardown marker each unsubscribe observes.
		const rootDir = createTempDir("senpi-config-reload-lazy-engine-");
		const watchedDirs = ["one", "two", "three"].map((name) => {
			const directory = join(rootDir, name);
			mkdirSync(directory);
			writeFileSync(join(directory, "config.json"), '{"a":1}\n', "utf-8");
			return directory;
		});
		const probe = createSlowTeardownProbe();
		const onRealChange = vi.fn();
		const engine = new ConfigReloadWatchEngine({
			targets: watchedDirs.map((path, index) => ({ id: `target-${index}`, kind: "dir" as const, path })),
			subscribe: probe.subscribe,
			onRealChange,
		});
		expect(watchedDirs.every((path) => probe.activeListenerCount(path) === 1)).toBe(true);

		// When: the engine is closed and the caller immediately marks that
		// control returned to it.
		const teardown = engine.close();
		probe.marker = "after-close-returned";

		// Then: no unsubscribe ran before close() returned, and every one of them
		// ran afterwards.
		expect(probe.unsubscribeMarkers).toEqual([]);
		await teardown;
		expect(probe.unsubscribeMarkers).toEqual([
			"after-close-returned",
			"after-close-returned",
			"after-close-returned",
		]);
		expect(watchedDirs.every((path) => probe.activeListenerCount(path) === 0)).toBe(true);
	});

	it("drops events delivered after close() while teardown is still pending", async () => {
		// Given: a closed engine whose subscriptions are still live because the
		// deferred unsubscribe loop has not drained yet.
		vi.useFakeTimers();
		const rootDir = createTempDir("senpi-config-reload-lazy-drop-");
		const watchedDir = join(rootDir, "watched");
		mkdirSync(watchedDir);
		const configPath = join(watchedDir, "config.json");
		writeFileSync(configPath, '{"a":1}\n', "utf-8");
		const probe = createSlowTeardownProbe();
		const onRealChange = vi.fn();
		const engine = new ConfigReloadWatchEngine({
			targets: [{ id: "target", kind: "dir", path: watchedDir }],
			subscribe: probe.subscribe,
			onRealChange,
			debounceMs: 200,
		});

		// When: a real content change is delivered to the still-attached listener
		// after close() returned.
		const teardown = engine.close();
		expect(probe.activeListenerCount(watchedDir)).toBe(1);
		writeFileSync(configPath, '{"a":2}\n', "utf-8");
		probe.emit(watchedDir, "config.json");
		await vi.advanceTimersByTimeAsync(200);

		// Then: the closed engine reported nothing, and teardown still completes.
		expect(onRealChange).not.toHaveBeenCalled();
		await teardown;
		expect(probe.activeListenerCount(watchedDir)).toBe(0);
	});

	it("returns from session_shutdown without waiting for the unsubscribe loop", async () => {
		// Given: a started extension whose watcher unsubscribes record the
		// teardown marker they observe.
		const agentDir = createTempDir("senpi-config-reload-lazy-shutdown-");
		writeFileSync(join(agentDir, "settings.json"), '{"theme":"dark"}\n', "utf-8");
		const probe = createSlowTeardownProbe();
		const extension = createManualExtension();
		configReloadExtension(extension.api, {
			agentDir,
			subscribe: probe.subscribe,
			logger: silentLogger(),
		});
		const context = fakeContext(agentDir);
		await invoke(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			context,
		);
		expect(probe.activeListenerCount(agentDir)).toBeGreaterThan(0);

		// When: the session shuts down for a reload.
		await invoke(
			extension.handlers,
			"session_shutdown",
			{ type: "session_shutdown", reason: "reload" } satisfies SessionShutdownEvent,
			context,
		);
		probe.marker = "after-shutdown-returned";

		// Then: the shutdown handler resolved before any unsubscribe ran.
		expect(probe.unsubscribeMarkers).toEqual([]);
	});
});
