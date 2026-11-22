import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestartableCommandHandler } from "../../src/core/extensions/builtin/terminal/durable-command.ts";
import { MonitorNotifier } from "../../src/core/extensions/builtin/terminal/monitor-notify.ts";
import {
	type MonitorEvent,
	MonitorRegistry,
	type MonitorSnapshotEntry,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { restoreTerminalState } from "../../src/core/extensions/builtin/terminal/restore.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import {
	FIRE_BUDGET_WINDOW_MS,
	RUNAWAY_PAUSE_SUMMARY_PREFIX,
	runawayPauseSummary,
} from "../../src/core/extensions/builtin/terminal/shared.ts";
import {
	type ManifestMonitor,
	TerminalManifestWriter,
} from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createNotifier, FakeScheduler, line, summary } from "./terminal-monitor-notify-harness.ts";

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

	identity(): undefined {
		return undefined;
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

/** `count` newline-terminated matching lines in one chunk, numbered from `from`. */
function lines(count: number, from = 0): string {
	return `${Array.from({ length: count }, (_, index) => `L${from + index}`).join("\n")}\n`;
}

function runawaySummaries(events: readonly MonitorEvent[]): MonitorEvent[] {
	return events.filter((event) => event.type === "summary" && event.summary.startsWith(RUNAWAY_PAUSE_SUMMARY_PREFIX));
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

function durable(registry: MonitorRegistry, id: string, options: { wakesPerHour?: number } = {}) {
	const runtime = fakeRuntime();
	registry.register({
		id,
		monitorId: `mon_${id}`,
		description: `${id} feed`,
		runtime,
		durabilityClass: "restartable-command",
		...(options.wakesPerHour === undefined ? {} : { wakesPerHour: options.wakesPerHour }),
	});
	return runtime;
}

/**
 * The production delivery chain without a PTY: registry events go through the real MonitorNotifier,
 * paced exactly the way extension.ts wires it (persistent command watches at `wakesPerHour`), with
 * the overflow file captured in memory. One clock drives both the registry (Date.now) and the
 * notifier (FakeScheduler); every simulated second notes activity, as an agent answering its wakes does.
 */
function deliveryChain(options: { wakesPerHour?: number; spill?: boolean } = {}) {
	vi.useFakeTimers();
	const startedAt = 1_700_000_000_000;
	vi.setSystemTime(startedAt);
	const scheduler = new FakeScheduler();
	const sent: string[] = [];
	const spilled: string[] = [];
	let notifier: MonitorNotifier | undefined;
	const chainRegistry = new MonitorRegistry((event) => notifier?.notifyEvent(event));
	openRegistries.push(chainRegistry);
	notifier = new MonitorNotifier({
		sendMessage: (message) => sent.push(message.content),
		getContext: () => ({ mode: "tui", model: { id: "mock", api: "openai-completions" } }) as never,
		getMode: () => "wake",
		getSettings: () => ({
			coalesceWindowMs: 2000,
			rateLimitMs: 5000,
			maxLinesPerInjection: 50,
			maxCharsPerInjection: 4096,
			wakeBudget: 5,
			wakesPerHour: 12,
		}),
		pauseMonitors: (ids) => chainRegistry.pause(ids),
		wakesPerHour: (id) => {
			const pacing = chainRegistry.wakePacing(id);
			return pacing === undefined ? undefined : (pacing.wakesPerHour ?? options.wakesPerHour ?? 12);
		},
		...(options.spill === false
			? {}
			: {
					spillOverflow: (_id: string, batch: readonly string[]) => {
						spilled.push(...batch);
						return { path: "/state/overflow/mon_feed.log", rotated: false };
					},
				}),
		scheduler,
	});
	const advance = (ms: number) => {
		const target = scheduler.now() + ms;
		while (scheduler.now() < target) {
			const step = Math.min(1000, target - scheduler.now());
			scheduler.advanceBy(step);
			vi.setSystemTime(startedAt + scheduler.now());
			notifier?.noteActivity();
		}
	};
	/** Every L<n> line the session received, inline in a wake or through the overflow file. */
	const received = () => [
		...sent.flatMap((content) => [...content.matchAll(/\bL\d+\b/g)].map((match) => match[0])),
		...spilled,
	];
	return { registry: chainRegistry, notifier, scheduler, sent, spilled, advance, received, startedAt };
}

describe("persistent command monitors are paced, never muted", () => {
	it("delivers all 500 lines a durable watch matches over a day, batched into paced wakes, with zero mutes", () => {
		const chain = deliveryChain();
		const runtime = durable(chain.registry, "bash_feed");
		let next = 0;
		// A realistic day: 250 lines one at a time, spread evenly, plus five bursts of 50.
		for (let hour = 0; hour < 24; hour += 1) {
			for (let tick = 0; tick < 10; tick += 1) {
				if (next < 250) {
					runtime.feed(lines(1, next));
					next += 1;
				}
				chain.advance(6 * 60 * 1000);
			}
			if (hour % 5 === 0 && next < 500) {
				runtime.feed(lines(50, next));
				next += 50;
			}
		}
		while (next < 500) {
			runtime.feed(lines(1, next));
			next += 1;
		}
		chain.advance(2 * 60 * 60 * 1000);

		const expected = Array.from({ length: 500 }, (_, index) => `L${index}`);
		expect(chain.received().sort()).toEqual([...expected].sort());
		expect(new Set(chain.received()).size).toBe(500);
		expect(entryOf(chain.registry.snapshot(), "bash_feed").paused).toBe(false);
		expect(chain.sent.some((content) => content.includes(RUNAWAY_PAUSE_SUMMARY_PREFIX))).toBe(false);
		expect(chain.sent.some((content) => content.includes("auto-muted"))).toBe(false);
		// 26 hours at 12 wakes an hour plus the initial burst of 12: the wake count stays bounded.
		expect(chain.sent.length).toBeLessThanOrEqual(12 + 26 * 12);
	});

	it("batches lines into the next wake once the burst of wake tokens is spent", () => {
		const chain = deliveryChain();
		const runtime = durable(chain.registry, "bash_chat");
		// One line every 10 s for 10 minutes: 60 lines, far above 12 wakes an hour.
		for (let index = 0; index < 60; index += 1) {
			runtime.feed(lines(1, index));
			chain.advance(10_000);
		}
		chain.advance(60 * 60 * 1000);

		expect(chain.received()).toEqual(Array.from({ length: 60 }, (_, index) => `L${index}`));
		// The first 12 wakes go out one line each; later lines wait for a token and arrive together.
		expect(chain.sent.length).toBeLessThanOrEqual(12 + 2);
		expect(chain.sent.at(-1)?.match(/\bL\d+\b/g)?.length ?? 0).toBeGreaterThan(1);
	});

	it("honours a per-monitor wakes_per_hour override", () => {
		const chain = deliveryChain();
		const runtime = durable(chain.registry, "bash_fast", { wakesPerHour: 3600 });
		for (let index = 0; index < 60; index += 1) {
			runtime.feed(lines(1, index));
			chain.advance(10_000);
		}
		chain.advance(60_000);
		expect(chain.received()).toEqual(Array.from({ length: 60 }, (_, index) => `L${index}`));
		// Unpaced at this rate: every 10 s line gets its own wake.
		expect(chain.sent.length).toBe(60);
	});

	it("names the overflow file for the lines that do not fit one wake, in order", () => {
		const chain = deliveryChain();
		const runtime = durable(chain.registry, "bash_burst");
		runtime.feed(lines(300));
		chain.advance(10_000);

		expect(chain.sent).toHaveLength(1);
		expect(chain.sent[0]).toContain("[250 more lines in /state/overflow/mon_feed.log]");
		expect(chain.spilled).toEqual(Array.from({ length: 250 }, (_, index) => `L${50 + index}`));
		expect(chain.received()).toHaveLength(300);
	});

	it("falls back to the bash_output pointer when a watch has no overflow file", () => {
		const chain = deliveryChain({ spill: false });
		const runtime = durable(chain.registry, "bash_nospill");
		runtime.feed(lines(60));
		chain.advance(10_000);
		expect(chain.sent[0]).toContain("[10 additional event lines omitted; peek bash_output for full history.]");
	});

	it("never paces an ephemeral watch and never runs the runaway guard on it", () => {
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		const runtime = fakeRuntime();
		registry.register({ id: "bash_eph", monitorId: "mon_eph", description: "ephemeral tail", runtime });

		runtime.feed(lines(1000));

		expect(lineCount(events)).toBe(1000);
		expect(runawaySummaries(events)).toEqual([]);
		expect(registry.wakePacing("bash_eph")).toBeUndefined();
		expect(entryOf(registry.snapshot(), "bash_eph").paused).toBe(false);
	});
});

describe("runaway guard", () => {
	function floodMinutes(
		runtime: ReturnType<typeof fakeRuntime>,
		minutes: number,
		perMinute: number,
		startedAt: number,
	) {
		for (let minute = 0; minute < minutes; minute += 1) {
			vi.setSystemTime(startedAt + minute * 60_000);
			runtime.feed(lines(perMinute, minute * perMinute));
		}
	}

	it("pauses a sustained flood with ONE visible notice naming the rearm call", () => {
		vi.useFakeTimers();
		const startedAt = 1_700_000_000_000;
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		registry.setRunawayGuard({ linesPerMinute: 120, minutes: 5 });
		vi.setSystemTime(startedAt);
		const runtime = durable(registry, "bash_flood");

		floodMinutes(runtime, 5, 200, startedAt);

		expect(runawaySummaries(events)).toEqual([
			{
				type: "summary",
				id: "bash_flood",
				description: "bash_flood feed",
				summary: runawayPauseSummary("bash_flood", 120, 5),
			},
		]);
		expect(runawayPauseSummary("bash_flood", 120, 5)).toContain(
			'monitor({ action: "rearm", bash_id: "bash_flood" })',
		);
		// Four full flood minutes plus 121 lines of the fifth reach the session before the pause.
		expect(lineCount(events)).toBe(4 * 200 + 121);
		expect(entryOf(registry.snapshot(), "bash_flood").paused).toBe(true);
		expect(registry.mutedDropped("bash_flood")).toBe(200 - 121);
	});

	it("does not trip on a flood shorter than the window, and a quiet minute resets the run", () => {
		vi.useFakeTimers();
		const startedAt = 1_700_000_000_000;
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		registry.setRunawayGuard({ linesPerMinute: 120, minutes: 5 });
		vi.setSystemTime(startedAt);
		const runtime = durable(registry, "bash_bursty");

		floodMinutes(runtime, 4, 200, startedAt);
		// Minute 5 is quiet (one line), then four more flood minutes: never five in a row.
		vi.setSystemTime(startedAt + 4 * 60_000);
		runtime.feed(lines(1, 10_000));
		floodMinutes(runtime, 4, 200, startedAt + 5 * 60_000);

		expect(runawaySummaries(events)).toEqual([]);
		expect(lineCount(events)).toBe(8 * 200 + 1);
		expect(entryOf(registry.snapshot(), "bash_bursty").paused).toBe(false);
	});

	it("rearm resumes a runaway-paused watch with a clean guard history", () => {
		vi.useFakeTimers();
		const startedAt = 1_700_000_000_000;
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		registry.setRunawayGuard({ linesPerMinute: 10, minutes: 1 });
		vi.setSystemTime(startedAt);
		const runtime = durable(registry, "bash_rearm");
		runtime.feed(lines(11));
		expect(runawaySummaries(events)).toHaveLength(1);
		expect(registry.rearm("bash_rearm")).toBe("rearmed");
		expect(entryOf(registry.snapshot(), "bash_rearm").paused).toBe(false);

		// The same minute again: the cleared history needs a fresh 11 lines to trip.
		runtime.feed(lines(10, 100));
		expect(runawaySummaries(events)).toHaveLength(1);
		runtime.feed(lines(1, 200));
		expect(runawaySummaries(events)).toHaveLength(2);
	});

	it("a runaway pause summary does not clear the notifier's session-global wake streak", () => {
		// Wake gaps equal rateLimitMs: a larger gap (> rateLimitMs x 2) legitimately breaks a
		// line-only streak, so every batch below must land inside that quiet-gap bound.
		const { notifier, pauseMonitors, scheduler, sent } = createNotifier({
			settings: { coalesceWindowMs: 10, rateLimitMs: 1000, wakeBudget: 6 },
		});
		for (let index = 0; index < 4; index += 1) {
			notifier.notifyEvent(line("bash_ci", "ci", `wake ${index}`));
			scheduler.advanceBy(1000);
		}
		expect(sent).toHaveLength(4);
		expect(pauseMonitors).not.toHaveBeenCalled();

		const pause = runawayPauseSummary("bash_ci", 120, 5);
		notifier.notifyEvent(summary("bash_ci", "ci", pause));
		scheduler.advanceBy(1000);
		expect(sent).toHaveLength(5);
		expect(sent[4]?.message.content).toContain(RUNAWAY_PAUSE_SUMMARY_PREFIX);
		expect(pauseMonitors).not.toHaveBeenCalled();

		notifier.notifyEvent(line("bash_ci", "ci", "wake after runaway pause"));
		scheduler.advanceBy(1000);
		expect(sent).toHaveLength(6);
		expect(pauseMonitors).toHaveBeenCalledTimes(1);
		expect(pauseMonitors).toHaveBeenCalledWith(["bash_ci"]);
	});
});

describe("durable fire window and wake override across a restart", () => {
	it("rolls the fire window over after 24h without ever pausing the watch", () => {
		vi.useFakeTimers();
		const startedAt = 1_700_000_000_000;
		vi.setSystemTime(startedAt);
		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		const runtime = durable(registry, "bash_roll");
		runtime.feed(lines(100));
		expect(entryOf(registry.snapshot(), "bash_roll").fireWindow?.count).toBe(100);

		vi.setSystemTime(startedAt + FIRE_BUDGET_WINDOW_MS + 1);
		runtime.feed(lines(1, 100));
		const rolled = entryOf(registry.snapshot(), "bash_roll");
		expect(rolled.fireWindow).toEqual({ startMs: startedAt + FIRE_BUDGET_WINDOW_MS + 1, count: 1 });
		expect(rolled.paused).toBe(false);
		expect(lineCount(events)).toBe(101);
	});

	it("keeps counting the persisted fire window after a restart and never mutes on it", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "senpi-fire-window-"));
		const workDir = join(sessionDir, "work");
		await mkdir(workDir, { recursive: true });
		const { entry, manifestPath } = await burnAndSuspend({
			sessionDir,
			sessionId: "fire-window-restore",
			workDir,
			monitorId: "mon_restore",
			count: 190,
		});
		const onDisk = JSON.parse(await readFile(manifestPath, "utf8")) as {
			monitors: Array<{ monitorId: string; fireWindow: { count: number } }>;
		};
		expect(onDisk.monitors.find((monitor) => monitor.monitorId === "mon_restore")?.fireWindow.count).toBe(190);

		const events: MonitorEvent[] = [];
		const registry = makeRegistry(events);
		const runtime = fakeRuntime();
		registry.register({
			id: "bash_genB",
			monitorId: "mon_restore",
			description: "flood tail",
			runtime,
			durabilityClass: "restartable-command",
			fireWindow: entry.fireWindow,
		});

		runtime.feed(lines(60));

		// The old budget muted at 200 (the 10th line here); every line now reaches the session.
		expect(lineCount(events)).toBe(60);
		expect(runawaySummaries(events)).toEqual([]);
		const live = entryOf(registry.snapshot(), "bash_genB");
		expect(live.paused).toBe(false);
		expect(live.fireWindow?.count).toBe(250);
	});

	it("persists wakes_per_hour in the manifest and re-applies it through the real restore handler", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "senpi-wake-override-"));
		const workDir = join(sessionDir, "work");
		await mkdir(workDir, { recursive: true });
		const session = { getSessionDir: () => sessionDir, getSessionId: () => "wake-override-restore" };
		const writerA = new TerminalManifestWriter({ session });
		await writerA.recordRegister({
			monitorId: "mon_chat",
			spec: {
				kind: "command",
				description: "chat bridge",
				command: "tail -F inbox.log",
				cwd: workDir,
				persistent: true,
				humanInput: true,
				wakesPerHour: 120,
			},
		});
		await writerA.recordShutdown();

		const writerB = new TerminalManifestWriter({ session });
		const persisted = (await writerB.store.read())?.monitors.find((monitor) => monitor.monitorId === "mon_chat");
		expect(persisted?.wakesPerHour).toBe(120);

		const registry = makeRegistry([]);
		const handler = createRestartableCommandHandler({
			ctx: {
				manager: { bindMonitorId: () => {} },
				cwd: workDir,
				defaultCols: 80,
				defaultRows: 24,
				getEnv: () => ({}),
			} as unknown as TerminalToolContext,
			registry,
			graceMs: 1,
			spawn: async () => ({ id: "bash_chat_restored", runtime: fakeRuntime() }),
		});
		const digest = await restoreTerminalState({
			manifest: writerB.store,
			handlers: { "restartable-command": handler },
		});
		expect(digest.restored).toBe(1);
		expect(registry.wakePacing("bash_chat_restored")).toEqual({ wakesPerHour: 120 });
	});
});
