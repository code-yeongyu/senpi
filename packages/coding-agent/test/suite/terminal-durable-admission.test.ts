import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { MonitorNotifier } from "../../src/core/extensions/builtin/terminal/monitor-notify.ts";
import { type MonitorEvent, MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import {
	type RestoreHandlers,
	reapplyPersistedMute,
	restoreTerminalState,
} from "../../src/core/extensions/builtin/terminal/restore.ts";
import { DURABLE_MONITOR_EXPIRY_MS, MAX_DURABLE_MONITORS } from "../../src/core/extensions/builtin/terminal/shared.ts";
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
import { spawnCommandSession } from "../../src/core/extensions/builtin/terminal/tools/spawn.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { FakeScheduler, line } from "./terminal-monitor-notify-harness.ts";

interface Harness {
	readonly writer: TerminalManifestWriter;
	readonly sessionId: string;
	readonly sessionDir: string;
	readonly manager: TerminalManager;
	readonly registry: MonitorRegistry;
	readonly ctx: TerminalToolContext;
	readonly tool: ReturnType<typeof createMonitorTool>;
	readonly events: MonitorEvent[];
	readonly createSpy: ReturnType<typeof vi.spyOn>;
	readonly registerSpy: ReturnType<typeof vi.spyOn>;
}

let harnessSeq = 0;
const openHarnesses: Harness[] = [];

async function makeHarness(now?: () => number): Promise<Harness> {
	harnessSeq += 1;
	const sessionId = `durable-admission-${process.pid}-${harnessSeq}`;
	// Never write inside the checkout: the manifest resolves under this absolute temp dir only.
	const sessionDir = await mkdtemp(join(tmpdir(), "senpi-durable-admission-"));
	const writer = new TerminalManifestWriter({
		session: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
		...(now ? { now } : {}),
	});
	expect(isAbsolute(writer.store.filePath)).toBe(true);
	expect(writer.store.filePath.startsWith(join(sessionDir, "extensions", "terminal"))).toBe(true);
	const manager = new TerminalManager();
	const events: MonitorEvent[] = [];
	const registry = new MonitorRegistry((event) => events.push(event), {
		onChange: (snapshot) => void writer.observeMonitorState(snapshot),
	});
	const ctx: TerminalToolContext = {
		manager,
		cwd: sessionDir,
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => ({ ...process.env }),
		onMonitorEvent: (event) => events.push(event),
		monitorRegistry: registry,
		getSessionContext: () => ({ sessionManager: { getSessionId: () => sessionId } }) as unknown as ExtensionContext,
	};
	bindTerminalManifestWriter(sessionId, writer);
	const harness: Harness = {
		writer,
		sessionId,
		sessionDir,
		manager,
		registry,
		ctx,
		tool: createMonitorTool(ctx),
		events,
		createSpy: vi.spyOn(manager, "create"),
		registerSpy: vi.spyOn(registry, "register"),
	};
	openHarnesses.push(harness);
	return harness;
}

async function closeHarness(harness: Harness): Promise<void> {
	harness.registry.dispose();
	await harness.manager.teardown();
	await harness.writer.flush();
	unbindTerminalManifestWriter(harness.sessionId);
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

async function createPersistent(harness: Harness, description: string) {
	return harness.tool.execute(`create-${description}`, {
		description,
		command: "cat",
		persistent: true,
	});
}

async function createEphemeral(harness: Harness, description: string) {
	return harness.tool.execute(`create-${description}`, {
		description,
		command: "cat",
		timeout_ms: 300_000,
	});
}

describe("durable monitor admission control", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
	});

	afterEach(async () => {
		while (openHarnesses.length > 0) {
			const harness = openHarnesses.pop();
			if (harness) await closeHarness(harness);
		}
		vi.restoreAllMocks();
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("admits exactly MAX_DURABLE_MONITORS persistent monitors and rejects the next with no spawn and no registration", async () => {
		const harness = await makeHarness();
		expect(MAX_DURABLE_MONITORS).toBe(5);
		for (let index = 1; index <= MAX_DURABLE_MONITORS; index += 1) {
			const created = await createPersistent(harness, `durable ${index}`);
			expect(created.isError, firstText(created)).toBeFalsy();
		}
		await harness.writer.flush();
		const spawnsBefore = harness.createSpy.mock.calls.length;
		const registrationsBefore = harness.registerSpy.mock.calls.length;

		const rejected = await createPersistent(harness, "durable overflow");

		expect(rejected.isError).toBe(true);
		expect(firstText(rejected)).toBe(
			`Cannot start another persistent monitor: this session already holds ${MAX_DURABLE_MONITORS} durable monitors (the maximum). Stop one with kill_bash first.`,
		);
		expect(harness.createSpy.mock.calls.length).toBe(spawnsBefore);
		expect(harness.registerSpy.mock.calls.length).toBe(registrationsBefore);
		expect(harness.registry.snapshot()).toHaveLength(MAX_DURABLE_MONITORS);
		await harness.writer.flush();
		const manifest = await harness.writer.store.read();
		expect(manifest?.monitors.map((entry) => entry.description)).toEqual([
			"durable 1",
			"durable 2",
			"durable 3",
			"durable 4",
			"durable 5",
		]);
	});

	it("never counts ephemeral monitors against the cap: 10 ephemeral first, then 5 persistent, all succeed", async () => {
		const harness = await makeHarness();
		// Ephemeral first: a cap that counted them would already be over budget by the 6th one,
		// so every persistent create below would be refused.
		for (let index = 1; index <= 10; index += 1) {
			const created = await createEphemeral(harness, `ephemeral ${index}`);
			expect(created.isError, firstText(created)).toBeFalsy();
		}
		for (let index = 1; index <= MAX_DURABLE_MONITORS; index += 1) {
			const created = await createPersistent(harness, `durable ${index}`);
			expect(created.isError, firstText(created)).toBeFalsy();
		}
		await harness.writer.flush();

		const manifest = await harness.writer.store.read();
		const durable = manifest?.monitors.filter((entry) => entry.durabilityClass !== "ephemeral") ?? [];
		const ephemeral = manifest?.monitors.filter((entry) => entry.durabilityClass === "ephemeral") ?? [];
		expect(durable).toHaveLength(MAX_DURABLE_MONITORS);
		expect(ephemeral).toHaveLength(10);
		expect(harness.registry.snapshot()).toHaveLength(MAX_DURABLE_MONITORS + 10);
	});

	it("registers a durable monitor with an absolute 7-day expiry that a restore and a rearm both leave byte-identical", async () => {
		const registeredAt = 1_700_000_000_000;
		// A moving clock: an expiry refreshed by any later transition is observable as a slide.
		let clock = registeredAt;
		const harness = await makeHarness(() => clock);
		const created = await createPersistent(harness, "expiry stable");
		expect(created.isError, firstText(created)).toBeFalsy();
		const monitorId = created.details?.monitor_id as string;
		const runtimeId = created.details?.bash_id as string;
		await harness.writer.flush();

		const atRegister = (await harness.writer.store.read())?.monitors[0];
		expect(atRegister?.expiresAt).toBe(registeredAt + DURABLE_MONITOR_EXPIRY_MS);

		// A restore reads the entry and re-reports it; it must never push the deadline out.
		const digest = await restoreTerminalState({
			manifest: harness.writer.store,
			handlers: {
				"restartable-command": () => ({ outcome: "restored" }),
			},
			now: () => registeredAt + 1_000,
		});
		expect(digest.restored).toBe(1);
		expect((await harness.writer.store.read())?.monitors[0]?.expiresAt).toBe(atRegister?.expiresAt);

		// A rearm is a delivery transition, not a lifetime transition.
		clock = registeredAt + 60_000;
		expect(harness.registry.pause([runtimeId])).toEqual([runtimeId]);
		await harness.writer.flush();
		expect((await harness.writer.store.read())?.monitors[0]?.expiresAt).toBe(atRegister?.expiresAt);
		clock = registeredAt + 120_000;
		const rearmed = await harness.tool.execute("rearm-expiry", { action: "rearm", bash_id: monitorId });
		expect(rearmed.isError, firstText(rearmed)).toBeFalsy();
		await harness.writer.flush();

		const afterRearm = (await harness.writer.store.read())?.monitors[0];
		expect(afterRearm?.expiresAt).toBe(atRegister?.expiresAt);
		expect(afterRearm?.createdAt).toBe(registeredAt);
		expect(afterRearm?.deliveryPaused).toBe(false);
	});

	it("does not restore an entry at or past expiresAt and never calls its handler", async () => {
		const harness = await makeHarness();
		const now = 4_000_000_000_000;
		const base: Omit<ManifestMonitor, "monitorId" | "expiresAt"> = {
			sessionId: harness.sessionId,
			description: "stale durable",
			runtimeKind: "command",
			durabilityClass: "restartable-command",
			command: "cat",
			createdAt: now - DURABLE_MONITOR_EXPIRY_MS,
			persistent: true,
			suspended: true,
			lastCheckpoint: null,
			deliveryPaused: false,
			wakeCount: 0,
			fireWindow: { startMs: 1, count: 0 },
		};
		await harness.writer.store.write({
			version: 1,
			sessionId: harness.sessionId,
			monitors: [
				{ ...base, monitorId: "mon_atexpiry", expiresAt: now },
				{ ...base, monitorId: "mon_pastexpiry", expiresAt: now - 1 },
			],
			backgroundSessions: [],
			updatedAt: now,
		});
		const seen: string[] = [];
		const handler = (monitor: ManifestMonitor) => {
			seen.push(monitor.monitorId);
			return { outcome: "restored" as const };
		};
		const handlers: RestoreHandlers = { "restartable-command": handler, "checkpointed-file": handler };

		const digest = await restoreTerminalState({ manifest: harness.writer.store, handlers, now: () => now });

		expect(digest).toEqual({
			restored: 0,
			lost: 0,
			expired: 2,
			muted: 0,
			attachedElsewhere: 0,
			storeError: false,
		});
		expect(seen).toEqual([]);
	});

	it("keeps a wake-budget mute across a restart: the restored monitor is paused in the snapshot and counted as muted", async () => {
		const first = await makeHarness();
		const created = await createPersistent(first, "noisy durable");
		expect(created.isError, firstText(created)).toBeFalsy();
		const monitorId = created.details?.monitor_id as string;
		const runtimeId = created.details?.bash_id as string;

		const scheduler = new FakeScheduler();
		const notifier = new MonitorNotifier({
			sendMessage: () => {},
			getContext: () => ({ mode: "tui", model: { id: "mock", api: "openai-completions" } }) as never,
			getMode: () => "wake",
			getSettings: () => ({
				coalesceWindowMs: 10,
				rateLimitMs: 1,
				maxLinesPerInjection: 50,
				maxCharsPerInjection: 4096,
				wakeBudget: 1,
			}),
			pauseMonitors: (ids) => first.registry.pause(ids),
			scheduler,
		});
		notifier.notifyEvent(line(runtimeId, "noisy durable", "chatter"));
		scheduler.advanceBy(10);
		notifier.dispose();

		expect(first.registry.snapshot().find((entry) => entry.id === runtimeId)?.paused).toBe(true);
		await first.writer.flush();
		const persisted = (await first.writer.store.read())?.monitors[0];
		expect(persisted?.monitorId).toBe(monitorId);
		expect(persisted?.deliveryPaused).toBe(true);

		// Restart: a fresh generation with its own registry restores the persisted entry.
		const second = await makeHarness();
		const restoredIds: string[] = [];
		const digest = await restoreTerminalState({
			manifest: first.writer.store,
			handlers: {
				"restartable-command": async (monitor) => {
					const { id, runtime } = await spawnCommandSession(second.ctx, {
						command: monitor.command ?? "cat",
						cols: 120,
						rows: 40,
					});
					second.registry.register({
						id,
						monitorId: monitor.monitorId,
						description: monitor.description,
						runtime,
					});
					restoredIds.push(id);
					return { outcome: reapplyPersistedMute(second.registry, monitor, id) };
				},
			},
		});

		expect(restoredIds).toHaveLength(1);
		expect(restoredIds[0]).not.toBe(monitorId);
		const restoredEntry = second.registry.snapshot().find((entry) => entry.monitorId === monitorId);
		expect(restoredEntry?.id).toBe(restoredIds[0]);
		expect(restoredEntry?.paused).toBe(true);
		expect(digest.muted).toBe(1);
		expect(digest.restored).toBe(0);
	});
});
