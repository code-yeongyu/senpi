import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventBus } from "../../src/core/event-bus.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import configReloadExtension, {
	type ConfigReloadExtensionOptions,
} from "../../src/core/extensions/builtin/config-reload/index.ts";
import type { ConfigReloadLogger } from "../../src/core/extensions/builtin/config-reload/log.ts";
import {
	CONFIG_WATCH_CHANGED,
	CONFIG_WATCH_REGISTER,
	CONFIG_WATCH_REJECTED,
	CONFIG_WATCH_RELOADED,
} from "../../src/core/extensions/builtin/config-reload/protocol.ts";
import type { WatchEventListener } from "../../src/core/extensions/builtin/config-reload/watch-engine.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionMode,
	ExtensionUIContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

type WatchProbe = {
	readonly subscribe: ConfigReloadExtensionOptions["subscribe"];
	readonly subscribeCalls: readonly string[];
	emit(path: string, filename: string | null): void;
	activeListenerCount(path: string): number;
};

type FixtureOptions = {
	readonly settingsContent?: string;
	readonly withReload?: boolean;
	readonly reload?: () => Promise<void>;
	readonly extraFactories?: Array<(pi: ExtensionAPI) => void>;
};

type Fixture = {
	readonly harness: Harness;
	readonly agentDir: string;
	readonly settingsPath: string;
	readonly watches: WatchProbe;
	readonly notifications: string[];
	readonly reload: ReturnType<typeof vi.fn>;
	readonly events: EventBus;
};

type RecordedHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

type ManualExtension = {
	readonly api: ExtensionAPI;
	readonly handlers: Map<string, RecordedHandler[]>;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

function createWatchProbe(): WatchProbe {
	const listeners = new Map<string, Set<WatchEventListener>>();
	const subscribeCalls: string[] = [];
	return {
		subscribe: (path, listener) => {
			subscribeCalls.push(path);
			const set = listeners.get(path) ?? new Set<WatchEventListener>();
			set.add(listener);
			listeners.set(path, set);
			return () => {
				set.delete(listener);
			};
		},
		subscribeCalls,
		emit: (path, filename) => {
			for (const listener of listeners.get(path) ?? []) listener("change", filename);
		},
		activeListenerCount: (path) => listeners.get(path)?.size ?? 0,
	};
}

function commandActions(reload: () => Promise<void>): ExtensionCommandContextActions {
	return {
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload,
	};
}

function ui(notify: (message: string, type?: "info" | "warning" | "error") => void): ExtensionUIContext {
	return { notify } as unknown as ExtensionUIContext;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value)}\n`, "utf-8");
}

async function settleChange(fixture: Fixture, path: string, filename: string | null): Promise<void> {
	fixture.watches.emit(path, filename);
	await vi.advanceTimersByTimeAsync(200);
	await Promise.resolve();
	await Promise.resolve();
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-extension-"));
	agentDirs.push(agentDir);
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, options.settingsContent ?? '{"theme":"dark"}\n', "utf-8");
	const watches = createWatchProbe();
	const notifications: string[] = [];
	const reload = vi.fn(options.reload ?? (async () => {}));
	let events: EventBus | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				events = pi.events;
				configReloadExtension(pi, { agentDir, subscribe: watches.subscribe });
			},
			...(options.extraFactories ?? []),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		...(options.withReload === false ? {} : { commandContextActions: commandActions(reload) }),
		mode: "tui",
		uiContext: ui((message) => notifications.push(message)),
	});
	if (!events) throw new Error("Expected config reload extension event bus");
	return { harness, agentDir, settingsPath, watches, notifications, reload, events };
}

function createManualExtension(bus: EventBus): ManualExtension {
	const handlers = new Map<string, RecordedHandler[]>();
	const api = {
		events: bus,
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
	index = -1,
): Promise<void> {
	const handler = handlers.get(eventName)?.at(index);
	if (!handler) throw new Error(`Missing ${eventName} handler`);
	await handler(event, ctx);
}

function fakeContext(options: {
	readonly cwd: string;
	readonly mode?: ExtensionMode;
	readonly notify?: (message: string) => void;
	readonly requestReload?: () => Promise<void>;
	readonly isCompacting?: () => boolean;
}): ExtensionContext {
	return {
		cwd: options.cwd,
		mode: options.mode ?? "tui",
		ui: ui((message) => options.notify?.(message)),
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		isCompacting: options.isCompacting ?? (() => false),
		requestReload: options.requestReload,
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

const harnesses: Harness[] = [];
const agentDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const directory of agentDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("config reload builtin extension", () => {
	it("is registered by default before final MCP and loads without diagnostics", async () => {
		const configReloadIndex = builtinExtensions.findIndex((extension) => extension.id === "config-reload");
		const mcpIndex = builtinExtensions.findIndex((extension) => extension.id === "mcp");
		expect(configReloadIndex).toBeGreaterThanOrEqual(0);
		expect(mcpIndex).toBeGreaterThan(configReloadIndex);

		const configReload = builtinExtensions[configReloadIndex];
		if (!configReload) throw new Error("config-reload builtin was not registered");
		const registrationDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-registration-"));
		agentDirs.push(registrationDir);
		const extensionsResult = await createTestExtensionsResult(
			[{ factory: configReload.factory, path: "<builtin:config-reload>" }],
			registrationDir,
		);
		expect(extensionsResult.errors).toEqual([]);
	});

	it("requests one reload and notifies when an idle settings file changes", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();

		writeFileSync(fixture.settingsPath, '{"theme":"light"}\n');
		await settleChange(fixture, fixture.agentDir, "settings.json");

		expect(fixture.reload).toHaveBeenCalledTimes(1);
		expect(fixture.notifications.some((message) => message.startsWith("Hot-reloading:"))).toBe(true);
	});

	it("ignores a same-byte settings rewrite", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();

		writeFileSync(fixture.settingsPath, '{"theme":"dark"}\n');
		await settleChange(fixture, fixture.agentDir, "settings.json");

		expect(fixture.reload).not.toHaveBeenCalled();
		expect(fixture.notifications).toEqual([]);
	});

	it("defers a busy reload and flushes after the harness settles", async () => {
		vi.useFakeTimers();
		const started = createDeferred();
		const release = createDeferred();
		const fixture = await createFixture();
		fixture.harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("finished");
			},
		]);
		const prompt = fixture.harness.session.prompt("keep the agent busy");
		await started.promise;

		writeFileSync(fixture.settingsPath, '{"theme":"light"}\n');
		await settleChange(fixture, fixture.agentDir, "settings.json");
		expect(fixture.reload).not.toHaveBeenCalled();
		expect(fixture.notifications).toContain("Config changed; reloading when idle");

		release.resolve();
		await prompt;
		expect(fixture.reload).toHaveBeenCalledTimes(1);
	});

	it("suppresses a SettingsManager self-write", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		const writer = SettingsManager.create(fixture.harness.tempDir, fixture.agentDir, { projectTrusted: true });
		writer.setTheme("light");
		await writer.flush();

		await settleChange(fixture, fixture.agentDir, "settings.json");

		expect(fixture.reload).not.toHaveBeenCalled();
	});

	it("rejects a registered target whose validator fails", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		const externalDir = join(fixture.harness.tempDir, "external");
		mkdirSync(externalDir);
		const externalPath = join(externalDir, "omo.json");
		writeFileSync(externalPath, "before");
		const rejected: unknown[] = [];
		fixture.events.on(CONFIG_WATCH_REJECTED, (payload) => rejected.push(payload));
		fixture.events.emit(CONFIG_WATCH_REGISTER, {
			id: "external",
			displayName: "External config",
			targets: [{ path: externalDir, kind: "dir" }],
			validate: () => ({ ok: false, errors: ["invalid external config"] }),
		});

		writeFileSync(externalPath, "after");
		await settleChange(fixture, externalDir, "omo.json");

		expect(fixture.reload).not.toHaveBeenCalled();
		expect(fixture.notifications.some((message) => message.includes("invalid external config"))).toBe(true);
		expect(rejected).toContainEqual({
			registrationId: "external",
			paths: [externalPath],
			errors: ["invalid external config"],
		});
	});

	it("rejects syntactically invalid settings before reload and logs the rejection", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		const runningSettings = SettingsManager.create(fixture.harness.tempDir, fixture.agentDir, {
			projectTrusted: true,
		});
		expect(runningSettings.getThemeSetting()).toBe("dark");

		writeFileSync(fixture.settingsPath, "{ invalid");
		await settleChange(fixture, fixture.agentDir, "settings.json");

		expect(fixture.reload).not.toHaveBeenCalled();
		expect(runningSettings.getThemeSetting()).toBe("dark");
		expect(fixture.notifications.some((message) => message.startsWith("Config change rejected:"))).toBe(true);
		expect(readFileSync(join(fixture.agentDir, "logs", "config-reload.log"), "utf-8")).toContain(
			'"event":"validation_rejected"',
		);
	});

	it("rejects a models.json schema error before reload", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		writeFileSync(join(fixture.agentDir, "models.json"), '{"providers":"not-an-object"}\n');

		await settleChange(fixture, fixture.agentDir, "models.json");

		expect(fixture.reload).not.toHaveBeenCalled();
		expect(fixture.notifications.some((message) => message.includes("Invalid models.json schema"))).toBe(true);
	});

	it("rejects malformed keybindings roots and values before reload", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		const keybindingsPath = join(fixture.agentDir, "keybindings.json");
		writeFileSync(keybindingsPath, "[]\n");
		await settleChange(fixture, fixture.agentDir, "keybindings.json");
		writeFileSync(keybindingsPath, '{"submit":42}\n');
		await settleChange(fixture, fixture.agentDir, "keybindings.json");

		expect(fixture.reload).not.toHaveBeenCalled();
		expect(fixture.notifications.filter((message) => message.startsWith("Config change rejected:")).length).toBe(2);
	});

	for (const [label, content] of [
		["null", "null"],
		["string", '"x"'],
		["number", "5"],
		["array", "[]"],
		["comments", "// not JSON\n{}"],
	] as const) {
		it(`rejects a ${label} settings.json root before reload`, async () => {
			vi.useFakeTimers();
			const fixture = await createFixture();
			writeFileSync(fixture.settingsPath, content);

			await settleChange(fixture, fixture.agentDir, "settings.json");

			expect(fixture.reload).not.toHaveBeenCalled();
			expect(fixture.notifications.some((message) => message.startsWith("Config change rejected:"))).toBe(true);
		});
	}

	it("closes watchers and event-bus listeners on shutdown before a replacement factory runs", async () => {
		vi.useFakeTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-cleanup-"));
		agentDirs.push(agentDir);
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		const bus = createEventBus();
		const watches = createWatchProbe();
		const first = createManualExtension(bus);
		configReloadExtension(first.api, { agentDir, subscribe: watches.subscribe, logger: silentLogger() });
		const firstContext = fakeContext({ cwd: agentDir });
		await invoke(first.handlers, "session_start", { type: "session_start", reason: "startup" }, firstContext);
		expect(watches.activeListenerCount(agentDir)).toBeGreaterThan(0);

		await invoke(
			first.handlers,
			"session_shutdown",
			{ type: "session_shutdown", reason: "reload" } satisfies SessionShutdownEvent,
			firstContext,
		);
		expect(watches.activeListenerCount(agentDir)).toBe(0);
		bus.emit(CONFIG_WATCH_REGISTER, {
			id: "old-listener",
			displayName: "Old listener",
			targets: [{ path: join(agentDir, "old"), kind: "dir" }],
		});
		expect(watches.activeListenerCount(join(agentDir, "old"))).toBe(0);

		const second = createManualExtension(bus);
		configReloadExtension(second.api, { agentDir, subscribe: watches.subscribe, logger: silentLogger() });
		await invoke(
			second.handlers,
			"session_start",
			{ type: "session_start", reason: "reload" } satisfies SessionStartEvent,
			fakeContext({ cwd: agentDir }),
		);
		const externalDir = join(agentDir, "external");
		bus.emit(CONFIG_WATCH_REGISTER, {
			id: "replacement",
			displayName: "Replacement listener",
			targets: [{ path: externalDir, kind: "dir" }],
		});

		expect(watches.activeListenerCount(externalDir)).toBe(1);
	});

	it("buffers factory-time registrations until session_start", async () => {
		vi.useFakeTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-buffer-"));
		agentDirs.push(agentDir);
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		const externalDir = join(agentDir, "external");
		mkdirSync(externalDir);
		const bus = createEventBus();
		const watches = createWatchProbe();
		const extension = createManualExtension(bus);
		configReloadExtension(extension.api, { agentDir, subscribe: watches.subscribe, logger: silentLogger() });
		bus.emit(CONFIG_WATCH_REGISTER, {
			id: "buffered",
			displayName: "Buffered registration",
			targets: [{ path: externalDir, kind: "dir" }],
		});
		expect(watches.activeListenerCount(externalDir)).toBe(0);

		await invoke(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			fakeContext({ cwd: agentDir }),
		);
		expect(watches.activeListenerCount(externalDir)).toBe(1);
	});

	it.each(["print", "json"] as const)("does not start watchers in short-lived %s mode", async (mode) => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-short-lived-"));
		agentDirs.push(agentDir);
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		const watches = createWatchProbe();
		const extension = createManualExtension(createEventBus());
		configReloadExtension(extension.api, { agentDir, subscribe: watches.subscribe, logger: silentLogger() });

		await invoke(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			fakeContext({ cwd: agentDir, mode }),
		);

		expect(watches.subscribeCalls).toEqual([]);
	});

	it("emits changed without throwing when the host has no requestReload action", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture({ withReload: false });
		const changed: unknown[] = [];
		fixture.events.on(CONFIG_WATCH_CHANGED, (payload) => changed.push(payload));
		writeJson(fixture.settingsPath, { theme: "light" });

		await settleChange(fixture, fixture.agentDir, "settings.json");

		expect(fixture.reload).not.toHaveBeenCalled();
		expect(changed).toContainEqual({
			registrationId: "builtin",
			paths: [fixture.settingsPath],
			deferred: true,
		});
	});

	it("logs unavailable requestReload once while continuing to emit changed events", async () => {
		vi.useFakeTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-no-reload-"));
		agentDirs.push(agentDir);
		const settingsPath = join(agentDir, "settings.json");
		writeJson(settingsPath, { theme: "dark" });
		const watches = createWatchProbe();
		const info = vi.fn();
		const logger: ConfigReloadLogger = {
			debug: vi.fn(),
			info,
			warn: vi.fn(),
			error: vi.fn(),
		};
		const bus = createEventBus();
		const changed: unknown[] = [];
		bus.on(CONFIG_WATCH_CHANGED, (payload) => changed.push(payload));
		const extension = createManualExtension(bus);
		configReloadExtension(extension.api, { agentDir, subscribe: watches.subscribe, logger });
		await invoke(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			fakeContext({ cwd: agentDir }),
		);

		writeJson(settingsPath, { theme: "light" });
		watches.emit(agentDir, "settings.json");
		await vi.advanceTimersByTimeAsync(200);
		writeJson(settingsPath, { theme: "dark" });
		watches.emit(agentDir, "settings.json");
		await vi.advanceTimersByTimeAsync(200);

		expect(changed).toHaveLength(2);
		expect(
			info.mock.calls.filter(([event]) => event === "reload_requested"),
		).toEqual([["reload_requested", { reason: "requestReload unavailable", paths: [] }]]);
	});

	it("does not construct project watchers when the session is untrusted", async () => {
		vi.useFakeTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-untrusted-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "senpi-config-reload-untrusted-cwd-"));
		agentDirs.push(agentDir, cwd);
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		const projectDir = join(cwd, ".senpi");
		mkdirSync(projectDir);
		writeJson(join(projectDir, "settings.json"), { configReload: { enabled: false } });
		const bus = createEventBus();
		const watches = createWatchProbe();
		const extension = createManualExtension(bus);
		configReloadExtension(extension.api, { agentDir, subscribe: watches.subscribe, logger: silentLogger() });
		const context = fakeContext({ cwd });
		context.isProjectTrusted = () => false;

		await invoke(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			context,
		);

		expect(watches.subscribeCalls).not.toContain(projectDir);
	});

	it("starts no watchers when configReload is disabled", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture({ settingsContent: '{"configReload":{"enabled":false}}\n' });

		expect(fixture.watches.subscribeCalls).toEqual([]);
	});

	it("falls back to default watching when configReload fields are malformed", async () => {
		vi.useFakeTimers();
		const malformedConfigReload = '{"configReload":{"enabled":"yes","debounceMs":"fast","watch":"all"}}\n';
		const fixture = await createFixture({ settingsContent: malformedConfigReload });
		expect(fixture.watches.subscribeCalls).toContain(fixture.agentDir);

		writeFileSync(
			fixture.settingsPath,
			'{"theme":"light","configReload":{"enabled":"yes","debounceMs":"fast","watch":"all"}}\n',
		);
		await settleChange(fixture, fixture.agentDir, "settings.json");
		expect(fixture.reload).toHaveBeenCalledTimes(1);
	});

	it("excludes settings-declared skill paths when skills watching is disabled", async () => {
		vi.useFakeTimers();
		const skillDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-skill-"));
		agentDirs.push(skillDir);
		const fixture = await createFixture({
			settingsContent: JSON.stringify({
				skills: [skillDir],
				configReload: { watch: { skills: false } },
			}),
		});

		expect(fixture.watches.subscribeCalls).not.toContain(skillDir);
	});

	it("rechecks a deferred reload after real harness compaction clears its controller", async () => {
		vi.useFakeTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-compaction-"));
		agentDirs.push(agentDir);
		const settingsPath = join(agentDir, "settings.json");
		writeJson(settingsPath, { theme: "dark" });
		const watches = createWatchProbe();
		const compactEvent = createDeferred();
		const reload = vi.fn(async () => {});
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => configReloadExtension(pi, { agentDir, subscribe: watches.subscribe }),
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compaction summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", async () => {
						watches.emit(agentDir, "settings.json");
						await vi.advanceTimersByTimeAsync(200);
						compactEvent.resolve();
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			commandContextActions: commandActions(reload),
			mode: "tui",
			uiContext: ui(() => {}),
		});
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to keep" }],
			timestamp: now,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		writeJson(settingsPath, { theme: "light" });

		const compaction = harness.session.compact();
		await compactEvent.promise;
		expect(harness.session.isCompacting).toBe(true);
		expect(reload).not.toHaveBeenCalled();
		await compaction;
		expect(harness.session.isCompacting).toBe(false);

		await vi.advanceTimersByTimeAsync(250);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("keeps pending work when requestReload resolves without session_shutdown", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		writeJson(fixture.settingsPath, { theme: "light" });
		await settleChange(fixture, fixture.agentDir, "settings.json");
		expect(fixture.reload).toHaveBeenCalledTimes(1);

		await fixture.harness.getExtensionRunner().emit({ type: "agent_settled" });
		expect(fixture.reload).toHaveBeenCalledTimes(2);
	});

	it("starts late registrations immediately and replaces duplicate ids", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		const firstDir = join(fixture.harness.tempDir, "first");
		const secondDir = join(fixture.harness.tempDir, "second");
		mkdirSync(firstDir);
		mkdirSync(secondDir);
		const firstPath = join(firstDir, "config.json");
		const secondPath = join(secondDir, "config.json");
		writeFileSync(firstPath, "one");
		writeFileSync(secondPath, "one");
		fixture.events.emit(CONFIG_WATCH_REGISTER, {
			id: "dynamic",
			displayName: "First",
			targets: [{ path: firstDir, kind: "dir" }],
		});
		expect(fixture.watches.activeListenerCount(firstDir)).toBe(1);
		fixture.events.emit(CONFIG_WATCH_REGISTER, {
			id: "dynamic",
			displayName: "Second",
			targets: [{ path: secondDir, kind: "dir" }],
		});
		expect(fixture.watches.activeListenerCount(firstDir)).toBe(0);
		expect(fixture.watches.activeListenerCount(secondDir)).toBe(1);

		writeFileSync(secondPath, "two");
		await settleChange(fixture, secondDir, "config.json");
		expect(fixture.reload).toHaveBeenCalledTimes(1);
	});

	it("reloads once more for a hash changed during the reload window", async () => {
		vi.useFakeTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-handoff-"));
		agentDirs.push(agentDir);
		const settingsPath = join(agentDir, "settings.json");
		writeJson(settingsPath, { theme: "dark" });
		const bus = createEventBus();
		const watches = createWatchProbe();
		const reloaded: unknown[] = [];
		bus.on(CONFIG_WATCH_RELOADED, (payload) => reloaded.push(payload));
		const first = createManualExtension(bus);
		let firstContext: ExtensionContext | undefined;
		let second: ManualExtension | undefined;
		const secondReload = vi.fn(async () => {});
		const firstReload = vi.fn(async () => {
			if (!firstContext) throw new Error("Missing first context");
			await invoke(
				first.handlers,
				"session_shutdown",
				{ type: "session_shutdown", reason: "reload" } satisfies SessionShutdownEvent,
				firstContext,
			);
			writeJson(settingsPath, { theme: "during-reload" });
			second = createManualExtension(bus);
			configReloadExtension(second.api, { agentDir, subscribe: watches.subscribe, logger: silentLogger() });
			await invoke(
				second.handlers,
				"session_start",
				{ type: "session_start", reason: "reload" } satisfies SessionStartEvent,
				fakeContext({ cwd: agentDir, requestReload: secondReload }),
			);
		});
		configReloadExtension(first.api, { agentDir, subscribe: watches.subscribe, logger: silentLogger() });
		firstContext = fakeContext({ cwd: agentDir, requestReload: firstReload });
		await invoke(
			first.handlers,
			"session_start",
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			firstContext,
		);
		writeJson(settingsPath, { theme: "first-change" });
		watches.emit(agentDir, "settings.json");
		await vi.advanceTimersByTimeAsync(200);
		await Promise.resolve();
		await Promise.resolve();

		expect(firstReload).toHaveBeenCalledTimes(1);
		expect(second).toBeDefined();
		expect(secondReload).toHaveBeenCalledTimes(1);
		expect(reloaded).toContainEqual({ registrationId: "builtin", paths: [settingsPath] });
	});

	it("rejects credential and protected registration targets without filesystem or hash access", async () => {
		vi.useFakeTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-credential-"));
		agentDirs.push(agentDir);
		writeJson(join(agentDir, "settings.json"), { theme: "dark" });
		const bus = createEventBus();
		const watches = createWatchProbe();
		const watchSubscribe = vi.fn(watches.subscribe);
		const hashFile = vi.fn((path: string) => createHash("sha256").update(readFileSync(path)).digest("hex"));
		const guarded = createManualExtension(bus);
		configReloadExtension(guarded.api, {
			agentDir,
			subscribe: watchSubscribe,
			hashFile,
			logger: silentLogger(),
		});
		await invoke(
			guarded.handlers,
			"session_start",
			{ type: "session_start", reason: "reload" } satisfies SessionStartEvent,
			fakeContext({ cwd: agentDir }),
		);
		const rejected: unknown[] = [];
		bus.on(CONFIG_WATCH_REJECTED, (payload) => rejected.push(payload));
		const subscriptionsBefore = watchSubscribe.mock.calls.length;
		const hashesBefore = hashFile.mock.calls.length;

		for (const [id, path] of [
			["auth-file", join(agentDir, "auth.json")],
			["auth-container", agentDir],
			["sessions", join(agentDir, "sessions", "one.jsonl")],
			["logs", join(agentDir, "logs", "config-reload.log")],
		] as const) {
			bus.emit(CONFIG_WATCH_REGISTER, {
				id,
				displayName: id,
				targets: [{ path, kind: "file" }],
			});
		}

		expect(watchSubscribe).toHaveBeenCalledTimes(subscriptionsBefore);
		expect(hashFile).toHaveBeenCalledTimes(hashesBefore);
		expect(rejected).toHaveLength(4);
		expect(
			rejected.every((payload) => {
				if (!payload || typeof payload !== "object" || !("errors" in payload)) return false;
				return Array.isArray(payload.errors) && payload.errors.includes("Configuration watch target is restricted");
			}),
		).toBe(true);
	});
});
