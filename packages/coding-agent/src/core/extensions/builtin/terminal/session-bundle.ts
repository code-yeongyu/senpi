import type { WakeSourceStateItem } from "../monitor-state-event.ts";
import { runAllAsyncCleanup } from "./file-monitor-cleanup.ts";
import type { FileMonitorRegistryDependencies } from "./file-monitor-registry.ts";
import { TerminalManager, type TerminalManagerOptions } from "./manager.ts";
import { type MonitorEvent, MonitorRegistry, type MonitorSnapshotEntry } from "./monitor-registry.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import { DEFAULT_MAX_SESSIONS } from "./shared.ts";

export interface TerminalEventSinks {
	readonly onMonitorEvent: (event: MonitorEvent) => void;
	readonly onMonitorState: (snapshot: readonly MonitorSnapshotEntry[]) => void;
	readonly onBackgroundState: (snapshot: readonly WakeSourceStateItem[]) => void;
	readonly onBackgroundExit: (id: string, runtime: TerminalRuntimeSession) => void;
}

export interface TerminalSessionBundleOptions extends TerminalManagerOptions {
	readonly fileMonitor?: FileMonitorRegistryDependencies;
}

const MAX_PARKED_MONITOR_EVENTS = 100;

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
	readonly #maxParkedExits: number;
	#sinks: TerminalEventSinks | null = null;
	#parkedMonitorEvents: MonitorEvent[] = [];
	#parkedMonitorLineCount = 0;
	#parkedExits = new Map<string, TerminalRuntimeSession>();
	#backgrounds = new Map<string, WakeSourceStateItem>();
	#torndown = false;

	constructor(options: TerminalSessionBundleOptions) {
		this.#maxParkedExits = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
		let monitors: MonitorRegistry | undefined;
		this.manager = new TerminalManager({
			...options,
			getExternalSessionCount: () => monitors?.fileCount ?? 0,
		});
		monitors = new MonitorRegistry((event) => this.#dispatchMonitorEvent(event), {
			getTerminalSessionCount: () => this.manager.capacityCount,
			maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
			onChange: (snapshot) => this.#sinks?.onMonitorState(snapshot),
			fileMonitor: options.fileMonitor,
		});
		this.monitors = monitors;
	}

	/** Install live sinks, re-publish channel state, and flush everything buffered while parked. */
	bind(sinks: TerminalEventSinks): void {
		if (this.#torndown) return;
		this.#sinks = sinks;
		const parkedMonitorEvents = this.#parkedMonitorEvents;
		this.#parkedMonitorEvents = [];
		this.#parkedMonitorLineCount = 0;
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
		if (this.#parkedExits.size >= this.#maxParkedExits) return;
		this.#parkedExits.set(id, runtime);
	}

	async teardown(): Promise<void> {
		if (this.#torndown) return;
		this.#torndown = true;
		this.#parkedMonitorEvents = [];
		this.#parkedMonitorLineCount = 0;
		this.#parkedExits.clear();
		const hadBackgrounds = this.#backgrounds.size > 0;
		this.#backgrounds.clear();
		await runAllAsyncCleanup([
			() => this.monitors.teardown(),
			() => {
				if (hadBackgrounds) this.#sinks?.onBackgroundState([]);
			},
			() => {
				this.#sinks = null;
			},
			() => this.manager.teardown(),
		]);
	}

	#dispatchMonitorEvent(event: MonitorEvent): void {
		if (this.#torndown) return;
		if (this.#sinks) {
			this.#sinks.onMonitorEvent(event);
			return;
		}
		this.#parkedMonitorEvents.push(event);
		if (event.type !== "line") return;
		this.#parkedMonitorLineCount += 1;
		if (this.#parkedMonitorLineCount <= MAX_PARKED_MONITOR_EVENTS) return;
		const oldestLineIndex = this.#parkedMonitorEvents.findIndex((candidate) => candidate.type === "line");
		if (oldestLineIndex >= 0) {
			this.#parkedMonitorEvents.splice(oldestLineIndex, 1);
			this.#parkedMonitorLineCount -= 1;
		}
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
