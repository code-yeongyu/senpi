import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestartableCommandHandler } from "../../src/core/extensions/builtin/terminal/durable-command.ts";
import {
	type MonitorEvent,
	MonitorRegistry,
	type MonitorSnapshotEntry,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { restoreTerminalState } from "../../src/core/extensions/builtin/terminal/restore.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import {
	DEFAULT_DURABLE_MONITOR_FIRE_BUDGET,
	FIRE_BUDGET_AUTO_MUTE_SUMMARY,
	FIRE_BUDGET_WINDOW_MS,
} from "../../src/core/extensions/builtin/terminal/shared.ts";
import {
	type ManifestMonitor,
	TerminalManifestWriter,
} from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createNotifier, line, summary } from "./terminal-monitor-notify-harness.ts";

/**
 * A deterministic runtime: no PTY. `feed` pushes a chunk straight through the registry's
 * output subscription, so every case below controls exactly which lines a watch produces.
 */
class FakeRuntime {
	readonly command = "fake";
	readonly exited = false;
	readonly exitResult = null;
	readonly session = { onExit: () => () => {} };
	readonly #listeners = new Set<(chunk: string) => void>();

	fullOutput(): string {
		return "";
	}

	onOutput(listener: (chunk: string) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	feed(text: string): void {
		for (const listener of this.#listeners) listener(text);
	}
}

function fakeRuntime(): TerminalRuntimeSession & FakeRuntime {
	return new FakeRuntime() as TerminalRuntimeSession & FakeRuntime;
}

/** `count` newline-terminated matching lines in one chunk. */
function lines(count: number): string {
	return `${Array.from({ length: count }, (_, index) => `L${index}`).join("\n")}\n`;
}

function budgetSummaries(events: readonly MonitorEvent[]): MonitorEvent[] {
	return events.filter((event) => event.type === "summary" && event.summary === FIRE_BUDGET_AUTO_MUTE_SUMMARY);
}

function lineCount(events: readonly MonitorEvent[]): number {
	return events.filter((event) => event.type === "line").length;
}

function entryOf(snapshot: readonly MonitorSnapshotEntry[], id: string): MonitorSnapshotEntry {
	const entry = snapshot.find((candidate) => candidate.id === id);
	if (entry === undefined) throw new Error(`no snapshot entry for ${id}`);
	return entry;
}

const openRegistries: MonitorRegistry[] = [];

function makeRegistry(events: MonitorEvent[], onChange?: (snapshot: readonly MonitorSnapshotEntry[]) => void) {
	const registry = new MonitorRegistry((event) => events.push(event), { onChange });
	openRegistries.push(registry);
	return registry;
}

afterEach(() => {
	for (const registry of openRegistries.splice(0)) registry.dispose();
	vi.useRealTimers();
});

/**
 * Generation A of a restart: run a durable command watch, burn `count` fires of its window,
 * and persist the manifest exactly the way extension.ts shuts down (the final live-state
 * sync, then recordShutdown). Returns the persisted entry as a FRESH generation reads it
 * back from the manifest file, plus the file's path, so nothing is shared with generation A.
 */
async function burnAndSuspend(options: {
	sessionDir: string;
	sessionId: string;
	workDir: string;
	monitorId: string;
	count: number;
}): Promise<{ entry: ManifestMonitor; manifestPath: string }> {
	const session = { getSessionDir: () => options.sessionDir, getSessionId: () => options.sessionId };
	const writer = new TerminalManifestWriter({ session });
	const events: MonitorEvent[] = [];
	const registry = makeRegistry(events, (snapshot) => void writer.observeMonitorState(snapshot));
	const runtime = fakeRuntime();
	registry.register({
		id: "bash_genA",
		monitorId: options.monitorId,
		description: "flood tail",
		runtime,
		durabilityClass: "restartable-command",
	});
	await writer.recordRegister({
		monitorId: options.monitorId,
		spec: {
			kind: "command",
			description: "flood tail",
			command: "tail -F app.log",
			cwd: options.workDir,
			persistent: true,
		},
	});
	runtime.feed(lines(options.count));
	// Shutdown: the same final snapshot sync extension.ts performs before recordShutdown.
	await writer.observeMonitorState(registry.snapshot());
	await writer.recordShutdown();
	const entry = (await new TerminalManifestWriter({ session }).store.read())?.monitors.find(
		(monitor) => monitor.monitorId === options.monitorId,
	);
	if (entry === undefined) throw new Error(`generation A did not persist ${options.monitorId} to the manifest`);
	return { entry, manifestPath: writer.store.filePath };
}

describe("durable monitor rolling fire budget", () => {
	it("delivers exactly 200 of 201 matched lines on a durable monitor, then auto-mutes with ONE budget summary", () => {
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		const runtime = fakeRuntime();
		registry.register({
			id: "bash_1",
			monitorId: "mon_budget",
			description: "durable tail",
			runtime,
			durabilityClass: "restartable-command",
		});

		runtime.feed(lines(201));

		expect(lineCount(events)).toBe(DEFAULT_DURABLE_MONITOR_FIRE_BUDGET);
		expect(budgetSummaries(events)).toEqual([
			{
				type: "summary",
				id: "bash_1",
				description: "durable tail",
				summary: FIRE_BUDGET_AUTO_MUTE_SUMMARY,
			},
		]);
		// The 201st line never reached the session: the watch muted itself.
		expect(entryOf(registry.snapshot(), "bash_1").paused).toBe(true);
		expect(entryOf(registry.snapshot(), "bash_1").fireWindow?.count).toBe(200);
		expect(registry.mutedDropped("bash_1")).toBe(1);
	});

	it("delivers all 201 lines on an EPHEMERAL monitor and never mutes", () => {
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		const runtime = fakeRuntime();
		registry.register({ id: "bash_eph", monitorId: "mon_eph", description: "ephemeral tail", runtime });

		runtime.feed(lines(201));

		expect(lineCount(events)).toBe(201);
		expect(budgetSummaries(events)).toEqual([]);
		expect(entryOf(registry.snapshot(), "bash_eph").paused).toBe(false);
	});

	it("persists fireWindow across a restart: 150 lines before, mute at the 50th line after", async () => {
		// Never write inside the checkout: the manifest resolves under this absolute temp dir only.
		const sessionDir = await mkdtemp(join(tmpdir(), "senpi-fire-budget-"));
		const sessionId = "fire-budget-restart";
		const session = { getSessionDir: () => sessionDir, getSessionId: () => sessionId };

		// Generation 1: a durable command watch has burned 150 fires of its window.
		const writer1 = new TerminalManifestWriter({ session });
		const events1: MonitorEvent[] = [];
		const registry1 = makeRegistry(events1, (snapshot) => void writer1.observeMonitorState(snapshot));
		const runtime1 = fakeRuntime();
		registry1.register({
			id: "bash_1",
			monitorId: "mon_restart",
			description: "flood tail",
			runtime: runtime1,
			durabilityClass: "restartable-command",
		});
		await writer1.recordRegister({
			monitorId: "mon_restart",
			spec: { kind: "command", description: "flood tail", command: "tail -F app.log", persistent: true },
		});
		runtime1.feed(lines(150));
		expect(entryOf(registry1.snapshot(), "bash_1").fireWindow?.count).toBe(150);
		// Shutdown: the same final snapshot sync extension.ts performs before recordShutdown.
		await writer1.observeMonitorState(registry1.snapshot());
		await writer1.recordShutdown();

		// Generation 2: a fresh writer and registry read the persisted manifest back.
		const writer2 = new TerminalManifestWriter({ session });
		const persisted = (await writer2.store.read())?.monitors.find((m) => m.monitorId === "mon_restart");
		expect(persisted?.suspended).toBe(true);
		expect(persisted?.fireWindow.count).toBe(150);

		let sync2: Promise<void> = Promise.resolve();
		const events2: MonitorEvent[] = [];
		const registry2 = makeRegistry(events2, (snapshot) => {
			sync2 = writer2.observeMonitorState(snapshot);
		});
		const runtime2 = fakeRuntime();
		// durable-command's restore handler registers without durability fields; extension.ts
		// then re-adopts the entry and re-binds the persisted window. Mirror both calls.
		registry2.register({
			id: "bash_9",
			monitorId: "mon_restart",
			description: "flood tail",
			runtime: runtime2,
		});
		if (persisted === undefined) throw new Error("generation 1 did not persist the monitor entry");
		writer2.adoptRestored(persisted);
		expect(registry2.adoptFireWindow("mon_restart", persisted.fireWindow)).toBe(true);

		runtime2.feed(lines(60));

		// 150 + 50 = 200: the mute lands on the 50th post-restore line, not on a fresh 200.
		expect(lineCount(events2)).toBe(50);
		expect(budgetSummaries(events2)).toHaveLength(1);
		// The pause transition persists BOTH the mute and the window through the writer.
		await sync2;
		const afterPause = (await writer2.store.read())?.monitors.find((m) => m.monitorId === "mon_restart");
		expect(afterPause?.deliveryPaused).toBe(true);
		expect(afterPause?.fireWindow.count).toBe(200);
	});

	it("restores through the real restartable-command path and mutes at the budget counted across generations", async () => {
		// Never write inside the checkout: the manifest resolves under this absolute temp dir only.
		const sessionDir = await mkdtemp(join(tmpdir(), "senpi-fire-restore-"));
		const workDir = join(sessionDir, "work");
		await mkdir(workDir, { recursive: true });
		const session = { getSessionDir: () => sessionDir, getSessionId: () => "fire-budget-production-restore" };
		const { entry, manifestPath } = await burnAndSuspend({
			sessionDir,
			sessionId: "fire-budget-production-restore",
			workDir,
			monitorId: "mon_restore",
			count: 150,
		});

		// The manifest FILE itself carries the burned budget: a future change that stops
		// persisting fireWindow fails here, before any restore is even attempted.
		const onDisk = JSON.parse(await readFile(manifestPath, "utf8")) as {
			monitors: Array<{ monitorId: string; fireWindow: { count: number } }>;
		};
		expect(onDisk.monitors.find((monitor) => monitor.monitorId === "mon_restore")?.fireWindow.count).toBe(150);

		// Generation B: a fresh writer and registry restore through the same pieces extension.ts
		// wires — the real createRestartableCommandHandler driven by restoreTerminalState, with
		// the record() wrapper's adoptRestored + adoptFireWindow re-bind of the persisted window.
		const writer = new TerminalManifestWriter({ session });
		const events: MonitorEvent[] = [];
		let sync: Promise<void> = Promise.resolve();
		const registry = makeRegistry(events, (snapshot) => {
			sync = writer.observeMonitorState(snapshot);
		});
		const restoredRuntime = fakeRuntime();
		const handler = createRestartableCommandHandler({
			// The handler only touches manager.bindMonitorId and the default geometry here; the
			// spawn seam keeps this file PTY-free and deterministic like every other case in it.
			ctx: {
				manager: { bindMonitorId: () => {} },
				cwd: workDir,
				defaultCols: 80,
				defaultRows: 24,
				getEnv: () => ({}),
			} as unknown as TerminalToolContext,
			registry,
			spawn: async () => ({ id: "bash_restored", runtime: restoredRuntime }),
		});
		const digest = await restoreTerminalState({
			manifest: writer.store,
			handlers: {
				"restartable-command": async (monitor) => {
					const result = await handler(monitor);
					if (result.outcome === "restored" || result.outcome === "muted") {
						writer.adoptRestored(monitor);
						registry.adoptFireWindow(monitor.monitorId, monitor.fireWindow);
					}
					return result;
				},
			},
		});
		expect(digest.restored).toBe(1);

		restoredRuntime.feed(lines(60));

		// 150 burned before the restart + 50 after: the mute lands on the 50th post-restore
		// line, not on a fresh 200 within this generation.
		expect(lineCount(events)).toBe(50);
		expect(budgetSummaries(events)).toHaveLength(1);
		const muted = entryOf(registry.snapshot(), "bash_restored");
		expect(muted.paused).toBe(true);
		expect(muted.fireWindow?.count).toBe(200);
		expect(registry.mutedDropped("bash_restored")).toBe(10);
		// The pause transition persists BOTH the mute and the window through the writer.
		await sync;
		const repersisted = (await writer.store.read())?.monitors.find((monitor) => monitor.monitorId === "mon_restore");
		expect(repersisted?.deliveryPaused).toBe(true);
		expect(repersisted?.fireWindow.count).toBe(200);
		expect(entry.monitorId).toBe("mon_restore");
	});

	it("re-binds the persisted window AT REGISTER TIME: the budget counts the pre-restart fires", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "senpi-fire-register-"));
		const workDir = join(sessionDir, "work");
		await mkdir(workDir, { recursive: true });
		const { entry } = await burnAndSuspend({
			sessionDir,
			sessionId: "fire-budget-register-rebind",
			workDir,
			monitorId: "mon_rebind",
			count: 150,
		});
		expect(entry.fireWindow.count).toBe(150);

		// Generation B: register the restored entry on a FRESH registry, handing the persisted
		// window through RegisterMonitorOptions.fireWindow — the option whose contract is
		// "persisted fire window re-bound by a restore, so a restart cannot reset the budget".
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		const runtime = fakeRuntime();
		registry.register({
			id: "bash_genB",
			monitorId: "mon_rebind",
			description: "flood tail",
			runtime,
			durabilityClass: "restartable-command",
			fireWindow: entry.fireWindow,
		});

		runtime.feed(lines(60));

		// 150 + 50 = 200 across the restart: a register that silently swapped in a fresh
		// window would deliver all 60 lines and never mute — exactly the regression this pins.
		expect(lineCount(events)).toBe(50);
		expect(budgetSummaries(events)).toHaveLength(1);
		const muted = entryOf(registry.snapshot(), "bash_genB");
		expect(muted.paused).toBe(true);
		expect(muted.fireWindow?.count).toBe(200);
		expect(registry.mutedDropped("bash_genB")).toBe(10);
	});

	it("rearms a muted monitor: delivery resumes and the count restarts at 0 with the same window start", () => {
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		const runtime = fakeRuntime();
		registry.register({
			id: "bash_rearm",
			monitorId: "mon_rearm",
			description: "rearm tail",
			runtime,
			durabilityClass: "restartable-command",
		});
		runtime.feed(lines(200));
		expect(budgetSummaries(events)).toHaveLength(1);
		const muted = entryOf(registry.snapshot(), "bash_rearm");
		expect(muted.paused).toBe(true);
		expect(muted.fireWindow?.count).toBe(200);

		expect(registry.rearm("bash_rearm")).toBe("rearmed");
		const rearmed = entryOf(registry.snapshot(), "bash_rearm");
		expect(rearmed.paused).toBe(false);
		expect(rearmed.fireWindow?.count).toBe(0);
		expect(rearmed.fireWindow?.startMs).toBe(muted.fireWindow?.startMs);

		// A fresh budget: 200 more lines all deliver, and the last one re-triggers the mute.
		runtime.feed(lines(200));
		expect(lineCount(events)).toBe(400);
		expect(budgetSummaries(events)).toHaveLength(2);
		// The 201st line after the rearm is dropped while muted again.
		runtime.feed(lines(1));
		expect(lineCount(events)).toBe(400);
		expect(registry.mutedDropped("bash_rearm")).toBe(1);
	});

	it("rolls the window over after 24h, resetting the count so the budget replenishes", () => {
		vi.useFakeTimers();
		const startedAt = 1_700_000_000_000;
		vi.setSystemTime(startedAt);
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		const runtime = fakeRuntime();
		registry.register({
			id: "bash_roll",
			monitorId: "mon_roll",
			description: "rolling tail",
			runtime,
			durabilityClass: "restartable-command",
		});
		runtime.feed(lines(150));
		expect(entryOf(registry.snapshot(), "bash_roll").fireWindow?.count).toBe(150);

		vi.setSystemTime(startedAt + FIRE_BUDGET_WINDOW_MS + 1);
		runtime.feed(lines(1));
		const rolled = entryOf(registry.snapshot(), "bash_roll").fireWindow;
		expect(rolled?.count).toBe(1);
		expect(rolled?.startMs).toBe(startedAt + FIRE_BUDGET_WINDOW_MS + 1);

		// The replenished budget takes another full 200 lines to mute: the 150 pre-rollover
		// lines plus all 200 post-rollover ones deliver, with exactly one mute — at the 200th.
		runtime.feed(lines(199));
		expect(lineCount(events)).toBe(350);
		expect(budgetSummaries(events)).toHaveLength(1);
	});

	it("a fire-budget summary does not clear the notifier's session-global wake streak", () => {
		// Wake gaps equal rateLimitMs: a larger gap (> rateLimitMs x 2) legitimately breaks a
		// line-only streak, so every batch below must land inside that quiet-gap bound.
		const { notifier, pauseMonitors, scheduler, sent } = createNotifier({
			settings: { coalesceWindowMs: 10, rateLimitMs: 1000, wakeBudget: 6 },
		});
		// Four line-only wakes: the streak stands at 4 of 6, no global pause yet.
		for (let index = 0; index < 4; index += 1) {
			notifier.notifyEvent(line("bash_ci", "ci", `wake ${index}`));
			scheduler.advanceBy(1000);
		}
		expect(sent).toHaveLength(4);
		expect(pauseMonitors).not.toHaveBeenCalled();

		// The auto-mute summary must be delivered but must NOT count as a completion that
		// resets the streak (which would un-pause the session-global budget).
		notifier.notifyEvent(summary("bash_ci", "ci", FIRE_BUDGET_AUTO_MUTE_SUMMARY));
		scheduler.advanceBy(1000);
		expect(sent).toHaveLength(5);
		expect(sent[4]?.message.content).toContain(FIRE_BUDGET_AUTO_MUTE_SUMMARY);
		expect(pauseMonitors).not.toHaveBeenCalled();

		// The streak survived the summary: the next line-only wake reaches 6 and pauses.
		notifier.notifyEvent(line("bash_ci", "ci", "wake after auto-mute"));
		scheduler.advanceBy(1000);
		expect(sent).toHaveLength(6);
		expect(pauseMonitors).toHaveBeenCalledTimes(1);
		expect(pauseMonitors).toHaveBeenCalledWith(["bash_ci"]);
	});
});
