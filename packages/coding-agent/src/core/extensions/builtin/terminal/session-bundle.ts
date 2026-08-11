import type { WakeSourceStateItem } from "../monitor-state-event.ts";
import { TerminalManager, type TerminalManagerOptions } from "./manager.ts";
import { type MonitorEvent, MonitorRegistry, type MonitorSnapshotEntry } from "./monitor-registry.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";

export interface TerminalEventSinks {
	readonly onMonitorEvent: (event: MonitorEvent) => void;
	readonly onMonitorState: (snapshot: readonly MonitorSnapshotEntry[]) => void;
	readonly onBackgroundState: (snapshot: readonly WakeSourceStateItem[]) => void;
	readonly onBackgroundExit: (id: string, runtime: TerminalRuntimeSession) => void;
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
	#parkedExits = new Map<string, TerminalRuntimeSession>();
	#backgrounds = new Map<string, WakeSourceStateItem>();
	#torndown = false;

	constructor(options: TerminalManagerOptions) {
		this.manager = new TerminalManager(options);
		this.monitors = new MonitorRegistry((event) => this.#dispatchMonitorEvent(event), {
			onChange: (snapshot) => this.#sinks?.onMonitorState(snapshot),
		});
	}

	/** Install live sinks, re-publish channel state, and flush everything buffered while parked. */
	bind(sinks: TerminalEventSinks): void {
		if (this.#torndown) return;
		this.#sinks = sinks;
		const parkedMonitorEvents = this.#parkedMonitorEvents;
		this.#parkedMonitorEvents = [];
		const parkedExits = [...this.#parkedExits];
		this.#parkedExits.clear();
		sinks.onMonitorState(this.monitors.snapshot());
		sinks.onBackgroundState(this.backgroundSnapshot());
		for (const event of parkedMonitorEvents) sinks.onMonitorEvent(event);
		for (const [id, runtime] of parkedExits) sinks.onBackgroundExit(id, runtime);
	}

	park(): void {
		this.#sinks = null;
	}

	backgroundSnapshot(): readonly WakeSourceStateItem[] {
		return [...this.#backgrounds.values()];
	}

	notifyBackgroundStart(id: string, description: string, startedAtMs = Date.now()): void {
		if (this.#torndown) return;
		this.#backgrounds.set(id, { id, description, startedAtMs });
		this.#sinks?.onBackgroundState(this.backgroundSnapshot());
	}

	notifyBackgroundExit(id: string, runtime: TerminalRuntimeSession): void {
		if (this.#torndown) return;
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
		this.monitors.dispose();
		if (this.#backgrounds.size > 0) {
			this.#backgrounds.clear();
			this.#sinks?.onBackgroundState([]);
		}
		this.#torndown = true;
		this.#sinks = null;
		await this.manager.teardown();
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
