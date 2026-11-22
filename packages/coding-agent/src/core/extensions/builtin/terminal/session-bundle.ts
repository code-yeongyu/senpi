import type { TerminalBackgroundAgeEvent, WakeSourceStateItem } from "../monitor-state-event.ts";
import { BackgroundAgeSchedule, backgroundAgeEvent } from "./background-age.ts";
import { TerminalManager, type TerminalManagerOptions } from "./manager.ts";
import type { MonitorEndedEvent } from "./monitor-registry.ts";
import { type MonitorEvent, MonitorRegistry, type MonitorSnapshotEntry } from "./monitor-registry.ts";
import type { TerminalExitView } from "./tools/context.ts";

export interface TerminalEventSinks {
	readonly onMonitorEvent: (event: MonitorEvent) => void;
	readonly onMonitorState: (snapshot: readonly MonitorSnapshotEntry[], transition?: boolean) => void;
	readonly onMonitorEnded: (event: MonitorEndedEvent) => void;
	readonly onBackgroundState: (snapshot: readonly WakeSourceStateItem[]) => void;
	readonly onBackgroundExit: (id: string, runtime: TerminalExitView) => void;
	readonly onBackgroundAge: (event: TerminalBackgroundAgeEvent) => void;
}

export interface BackgroundStartDetails {
	readonly command?: string;
	readonly autoReapMinutes?: number;
}

const MAX_PARKED_MONITOR_EVENTS = 100;
const MAX_PARKED_EXITS = 32;

/**
 * The long-lived terminal runtime for one agent session: the PTY session manager plus
 * the monitor registry. A session reload replaces the extension runner and re-runs the
 * extension factory, so this state must outlive any single extension instance; event
 * routing goes through mutable sinks the current owner instance binds. While parked
 * (the reload window, or a headless reload that never re-binds) events buffer bounded.
 */
export class TerminalSessionBundle {
	readonly manager: TerminalManager;
	readonly monitors: MonitorRegistry;
	#sinks: TerminalEventSinks | null = null;
	#parkedMonitorEvents: MonitorEvent[] = [];
	#parkedMonitorEndings: MonitorEndedEvent[] = [];
	#parkedExits = new Map<string, TerminalExitView>();
	#backgrounds = new Map<string, WakeSourceStateItem>();
	readonly #ages = new BackgroundAgeSchedule((event) => this.#dispatchAge(event));
	/** Age events that came due while parked: only the newest per session is worth delivering. */
	#parkedAges = new Map<string, TerminalBackgroundAgeEvent>();
	/** Background sessions an interrupted turn's stop ended, by the turn id: their exit notice does not wake. */
	readonly #interruptStops = new Map<string, string>();
	readonly #runJobReleases = new Map<string, () => void>();
	#torndown = false;

	constructor(options: TerminalManagerOptions) {
		this.manager = new TerminalManager(options);
		this.monitors = new MonitorRegistry((event) => this.#dispatchMonitorEvent(event), {
			onChange: (snapshot) => this.#sinks?.onMonitorState(snapshot),
			onFire: (snapshot) => this.#sinks?.onMonitorState(snapshot, false),
			onEnded: (event) => {
				if (this.#sinks) this.#sinks.onMonitorEnded(event);
				else this.#parkedMonitorEndings.push(event);
			},
			reserve: () => this.manager.reserve(),
		});
	}

	/** Install live sinks, re-publish channel state, and flush everything buffered while parked. */
	bind(sinks: TerminalEventSinks): void {
		if (this.#torndown) return;
		this.#sinks = sinks;
		const parkedMonitorEvents = this.#parkedMonitorEvents;
		this.#parkedMonitorEvents = [];
		const parkedMonitorEndings = this.#parkedMonitorEndings;
		this.#parkedMonitorEndings = [];
		const parkedExits = [...this.#parkedExits];
		this.#parkedExits.clear();
		const parkedAges = [...this.#parkedAges.values()];
		this.#parkedAges.clear();
		sinks.onMonitorState(this.monitors.snapshot());
		sinks.onBackgroundState(this.backgroundSnapshot());
		for (const event of parkedMonitorEvents) sinks.onMonitorEvent(event);
		for (const event of parkedMonitorEndings) sinks.onMonitorEnded(event);
		for (const [id, runtime] of parkedExits) sinks.onBackgroundExit(id, runtime);
		for (const event of parkedAges) sinks.onBackgroundAge(event);
	}

	park(): void {
		this.#sinks = null;
	}

	backgroundSnapshot(): readonly WakeSourceStateItem[] {
		return [...this.#backgrounds.values()];
	}

	notifyBackgroundStart(
		id: string,
		description: string,
		startedAtMs = Date.now(),
		details: BackgroundStartDetails = {},
	): void {
		if (this.#torndown) return;
		this.#backgrounds.set(id, { id, description, startedAtMs });
		this.#ages.add({ id, description, startedAtMs, ...details });
		this.#sinks?.onBackgroundState(this.backgroundSnapshot());
	}

	/** Hold the release of the run job `id` was recorded as; its exit drops it. */
	trackRunJob(id: string, release: () => void): void {
		if (this.#torndown) return release();
		this.#runJobReleases.set(id, release);
	}

	/** Stop a session the interrupted turn `turnId` started; its exit notice then reaches the next turn without waking. */
	async stopForInterrupt(id: string, turnId: string): Promise<void> {
		const runtime = this.manager.get(id);
		if (runtime === null) throw new Error(`${id} runs on the session's tool child, which this stop does not reach`);
		this.#interruptStops.set(id, turnId);
		const stopped = await this.manager.stop(id);
		if (stopped && runtime.exited) return;
		this.#interruptStops.delete(id);
		if (!stopped) throw new Error(`the terminal manager has no session ${id} to stop`);
		throw new Error(`${id} was still running after the stop (TERM, then KILL)`);
	}

	/** The auto-reap's stop did not end a session still on the schedule: one notice; its age notices go on. */
	notifyBackgroundReapFailed(id: string, autoReapMinutes: number, reason: string): void {
		if (this.#torndown) return;
		const subject = this.#ages.get(id);
		if (!subject) return;
		const event = backgroundAgeEvent("reap_failed", { ...subject, autoReapMinutes }, Date.now());
		this.#dispatchAge({ ...event, reason });
	}

	notifyBackgroundExit(id: string, exited: TerminalExitView): void {
		if (this.#torndown) return;
		this.#runJobReleases.get(id)?.();
		this.#runJobReleases.delete(id);
		const interruptedTurn = this.#interruptStops.get(id);
		this.#interruptStops.delete(id);
		const runtime = interruptedTurn === undefined ? exited : stoppedByInterruptView(exited, interruptedTurn);
		const subject = this.#ages.remove(id);
		this.#parkedAges.delete(id);
		if (subject && runtime.autoReapedAfterMinutes !== undefined) {
			const reaped = { ...subject, autoReapMinutes: runtime.autoReapedAfterMinutes };
			this.#dispatchAge(backgroundAgeEvent("reaped", reaped, Date.now()));
		}
		if (this.#backgrounds.delete(id)) this.#sinks?.onBackgroundState(this.backgroundSnapshot());
		if (this.#sinks) {
			this.#sinks.onBackgroundExit(id, runtime);
			return;
		}
		if (this.#parkedExits.size >= MAX_PARKED_EXITS) return;
		this.#parkedExits.set(id, runtime);
	}

	async teardown(): Promise<void> {
		if (this.#torndown) return;
		this.#parkedMonitorEvents = [];
		this.#parkedExits.clear();
		this.#ages.dispose();
		this.#parkedAges.clear();
		for (const release of this.#runJobReleases.values()) release();
		this.#runJobReleases.clear();
		this.#interruptStops.clear();
		this.monitors.dispose();
		if (this.#backgrounds.size > 0) {
			this.#backgrounds.clear();
			this.#sinks?.onBackgroundState([]);
		}
		this.#torndown = true;
		this.#parkedMonitorEndings = [];
		this.#sinks = null;
		await this.manager.teardown();
	}

	#dispatchAge(event: TerminalBackgroundAgeEvent): void {
		if (this.#torndown) return;
		if (this.#sinks) this.#sinks.onBackgroundAge(event);
		else this.#parkedAges.set(event.id, event);
	}

	#dispatchMonitorEvent(event: MonitorEvent): void {
		if (this.#torndown) return;
		if (this.#sinks) {
			this.#sinks.onMonitorEvent(event);
			return;
		}
		this.#parkedMonitorEvents.push(event);
		if (this.#parkedMonitorEvents.length > MAX_PARKED_MONITOR_EVENTS) this.#parkedMonitorEvents.shift();
	}
}

function stoppedByInterruptView(runtime: TerminalExitView, turnId: string): TerminalExitView {
	return {
		exitResult: runtime.exitResult,
		...(runtime.autoReapedAfterMinutes === undefined
			? {}
			: { autoReapedAfterMinutes: runtime.autoReapedAfterMinutes }),
		stoppedByInterrupt: { turnId },
		fullOutput: () => runtime.fullOutput(),
	};
}

const parkedBundles = new Map<string, TerminalSessionBundle>();

/** Park a bundle across a reload; at most one parked bundle per session, older ones torn down. */
export async function parkBundle(sessionKey: string, bundle: TerminalSessionBundle): Promise<void> {
	const previous = parkedBundles.get(sessionKey);
	parkedBundles.set(sessionKey, bundle);
	if (previous && previous !== bundle) await previous.teardown();
}

export function claimParkedBundle(sessionKey: string): TerminalSessionBundle | undefined {
	const bundle = parkedBundles.get(sessionKey);
	parkedBundles.delete(sessionKey);
	return bundle;
}

export async function teardownParkedBundle(sessionKey: string): Promise<void> {
	const bundle = parkedBundles.get(sessionKey);
	parkedBundles.delete(sessionKey);
	await bundle?.teardown();
}
