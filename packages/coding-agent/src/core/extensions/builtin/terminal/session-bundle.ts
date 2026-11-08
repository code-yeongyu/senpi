import { createHash } from "node:crypto";
import type { WakeSourceStateItem } from "../monitor-state-event.ts";
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
		sinks.onMonitorState(this.monitors.snapshot());
		sinks.onBackgroundState(this.backgroundSnapshot());
		for (const event of parkedMonitorEvents) sinks.onMonitorEvent(event);
		for (const event of parkedMonitorEndings) sinks.onMonitorEnded(event);
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

	notifyBackgroundExit(id: string, runtime: TerminalExitView): void {
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
		this.#parkedMonitorEndings = [];
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

/** The scope id is opaque, so a scope's session ids carry a digest of it (`bash_s<digest>_N`), never the id itself. */
function scopeIdTag(scopeId: string): string {
	return `s${createHash("sha256").update(scopeId).digest("hex").slice(0, 12)}`;
}

/** Called once when a scope's bundle is created: configures it and returns the sinks that route that scope's events. */
export type OpenTerminalScope = (scopeId: string, bundle: TerminalSessionBundle) => TerminalEventSinks;

/**
 * Terminal bundles per execution scope (senpi brain/hand S16a): when one runtime serves several scopes, each gets its
 * own bundle, so its PTY sessions, monitors, background sessions and their events are its own and `maxSessions`
 * applies per scope. Releasing a scope tears down exactly its bundle; a scope that never asks for one starts nothing.
 */
export class ScopedTerminalBundles {
	readonly #options: Omit<TerminalManagerOptions, "idScope">;
	readonly #open: OpenTerminalScope;
	readonly #bundles = new Map<string, TerminalSessionBundle>();
	#disposed = false;

	constructor(options: Omit<TerminalManagerOptions, "idScope">, open: OpenTerminalScope) {
		this.#options = options;
		this.#open = open;
	}

	forScope(scopeId: string): TerminalSessionBundle {
		if (this.#disposed) throw new Error("The terminal scopes of this runtime are disposed.");
		const existing = this.#bundles.get(scopeId);
		if (existing) return existing;
		const bundle = new TerminalSessionBundle({ ...this.#options, idScope: scopeIdTag(scopeId) });
		this.#bundles.set(scopeId, bundle);
		bundle.bind(this.#open(scopeId, bundle));
		return bundle;
	}

	peek(scopeId: string): TerminalSessionBundle | undefined {
		return this.#bundles.get(scopeId);
	}

	async releaseScope(scopeId: string): Promise<void> {
		const bundle = this.#bundles.get(scopeId);
		this.#bundles.delete(scopeId);
		await bundle?.teardown();
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		const bundles = [...this.#bundles.values()];
		this.#bundles.clear();
		const failures: unknown[] = [];
		for (const outcome of await Promise.allSettled(bundles.map((bundle) => bundle.teardown()))) {
			if (outcome.status === "rejected") failures.push(outcome.reason);
		}
		if (failures.length > 0) throw new AggregateError(failures, "Failed to tear down scoped terminal bundles");
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
