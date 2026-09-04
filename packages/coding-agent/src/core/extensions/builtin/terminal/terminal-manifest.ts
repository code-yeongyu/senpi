/**
 * The manifest write side: `createTerminalManifestStore` plus `TerminalManifestWriter`,
 * persisting ONLY lifecycle transitions and debounced checkpoints of the record shaped in
 * `terminal-manifest-model.ts` — never per-line output and never a runtime handle.
 */

import { join } from "node:path";
import { createSidecarStore, type SidecarStore } from "../../../session-sidecar-store.ts";
import type { MonitorSnapshotEntry } from "./monitor-registry.ts";
import { parseTerminalManifest } from "./restore.ts";
import { DURABLE_MONITOR_EXPIRY_MS } from "./shared.ts";
import {
	type ManifestBackgroundSession,
	type ManifestMonitor,
	type MonitorRegistration,
	TERMINAL_MANIFEST_CHECKPOINT_DEBOUNCE_MS,
	TERMINAL_MANIFEST_VERSION,
	type TerminalManifest,
	type TerminalManifestCheckpoint,
	type TerminalManifestSession,
} from "./terminal-manifest-model.ts";

export type {
	CommandMonitorSpec,
	FileMonitorSpec,
	ManifestBackgroundSession,
	ManifestMonitor,
	MonitorDurabilityClass,
	MonitorRegistration,
	MonitorRuntimeKind,
	MonitorSpec,
	TerminalManifest,
	TerminalManifestCheckpoint,
	TerminalManifestSession,
} from "./terminal-manifest-model.ts";
// The data model is re-exported so every importer keeps this module as the manifest's single
// entry point; nothing outside had to learn the model module's path.
export {
	DURABLE_MONITOR_EXPIRY_MS,
	TERMINAL_MANIFEST_CHECKPOINT_DEBOUNCE_MS,
	TERMINAL_MANIFEST_VERSION,
} from "./terminal-manifest-model.ts";

export function createTerminalManifestStore(session: TerminalManifestSession): SidecarStore<TerminalManifest> {
	return createSidecarStore({
		baseDir: join(session.getSessionDir(), "extensions", "terminal"),
		sessionId: session.getSessionId(),
		version: TERMINAL_MANIFEST_VERSION,
		tempPrefix: "terminal",
		parse: parseTerminalManifest,
	});
}

export class TerminalManifestWriter {
	readonly store: SidecarStore<TerminalManifest>;
	readonly #sessionId: string;
	readonly #debounceMs: number;
	readonly #now: () => number;
	readonly #entries = new Map<string, ManifestMonitor>();
	readonly #backgrounds = new Map<string, ManifestBackgroundSession>();
	readonly #pending = new Map<string, TerminalManifestCheckpoint>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#tail: Promise<void> = Promise.resolve();
	/** Last persist failure: transitions never reject, so a durability write can never fail a live tool call. */
	persistFailure: unknown;

	constructor(options: { session: TerminalManifestSession; debounceMs?: number; now?: () => number }) {
		this.store = createTerminalManifestStore(options.session);
		this.#sessionId = options.session.getSessionId();
		this.#debounceMs = options.debounceMs ?? TERMINAL_MANIFEST_CHECKPOINT_DEBOUNCE_MS;
		this.#now = options.now ?? Date.now;
	}

	recordRegister(registration: MonitorRegistration): Promise<void> {
		this.#entries.set(registration.monitorId, this.#entryFor(registration));
		return this.#persist();
	}

	/**
	 * Re-adopt an entry a restore handler just brought back to life, so THIS generation's
	 * in-memory map owns it again. Without this, the writer starts every generation empty and
	 * the next persist (a register, a background start, a checkpoint flush, recordShutdown)
	 * rewrites the manifest WITHOUT the restored monitors — the monitor survives one restart
	 * and is erased on the second.
	 *
	 * Every persisted field is preserved verbatim, notably `createdAt` and `expiresAt`: the
	 * durability deadline is set once at registration and a restore NEVER extends it. Only
	 * `suspended` is cleared, because the monitor is live again in this process.
	 *
	 * Deliberately does NOT write: re-adoption is not a state transition, it is recovery of
	 * state already on disk. The entry reaches the file again on the restore's own next
	 * persist (the file class's checkpoint, any later transition, or recordShutdown), so a
	 * restart costs zero extra writes and the write-on-transition invariant holds.
	 */
	adoptRestored(entry: ManifestMonitor): void {
		this.#entries.set(entry.monitorId, { ...entry, suspended: false });
	}

	/**
	 * Live durable-monitor count for admission control: entries that survive a restart.
	 * Ephemeral entries are never counted, so any number of one-shot watches can coexist
	 * with the durable ones.
	 */
	durableCount(): number {
		let count = 0;
		for (const entry of this.#entries.values()) if (entry.durabilityClass !== "ephemeral") count += 1;
		return count;
	}

	/**
	 * Reconcile a registry transition snapshot (the bundle's single onChange consumer
	 * forwards it here): settle removes entries, pause/resume/rearm flips deliveryPaused.
	 * An entry missing its stable monitorId throws — never silently skipped; entries not
	 * registered through the tool call site are left alone (durability spec unknown).
	 */
	observeMonitorState(snapshot: readonly MonitorSnapshotEntry[]): Promise<void> {
		const live = new Map<string, { paused: boolean; fireWindow?: MonitorSnapshotEntry["fireWindow"] }>();
		for (const entry of snapshot) {
			if (typeof entry.monitorId !== "string" || entry.monitorId.length === 0) {
				throw new Error(
					`terminal manifest writer saw a monitor snapshot entry without a stable monitorId (runtime id ${entry.id}); surfacing instead of silently skipping it`,
				);
			}
			live.set(entry.monitorId, { paused: entry.paused, fireWindow: entry.fireWindow });
		}
		let changed = false;
		for (const [monitorId, known] of this.#entries) {
			const current = live.get(monitorId);
			if (current === undefined) {
				if (known.suspended) continue; // shutdown-suspended entries are expected to be absent
				this.#entries.delete(monitorId); // settle: the registry transitioned it out
				changed = true;
				continue;
			}
			// The live fire window rides every state transition — notably the auto-mute pause —
			// so a restart re-binds the burned budget instead of a fresh one.
			const fireWindow = current.fireWindow ?? known.fireWindow;
			if (known.deliveryPaused !== current.paused || known.fireWindow.count !== fireWindow.count) {
				this.#entries.set(monitorId, { ...known, deliveryPaused: current.paused, fireWindow });
				changed = true;
			}
		}
		return changed ? this.#persist() : Promise.resolve();
	}

	/** Debounced checkpoint persist: a burst inside the window collapses into one write. */
	scheduleCheckpoint(monitorId: string, checkpoint: TerminalManifestCheckpoint): void {
		this.#pending.set(monitorId, checkpoint);
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#absorbPending();
			void this.#persist();
		}, this.#debounceMs);
	}

	/** Drain: apply any pending checkpoints and await every in-flight write. */
	async flush(): Promise<void> {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#pending.size === 0) await this.#tail;
		else {
			this.#absorbPending();
			await this.#persist();
		}
	}
	/** Shutdown transition: flush checkpoints and mark every live monitor suspended in one write. */
	async recordShutdown(): Promise<void> {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#absorbPending();
		for (const [monitorId, entry] of this.#entries) this.#entries.set(monitorId, { ...entry, suspended: true });
		await this.#persist();
	}

	recordBackgroundStart(id: string, command: string, startedAtMs?: number): Promise<void> {
		this.#backgrounds.set(id, { id, command, startedAtMs: startedAtMs ?? this.#now() });
		return this.#persist();
	}

	recordBackgroundExit(id: string): Promise<void> {
		return this.#backgrounds.delete(id) ? this.#persist() : Promise.resolve();
	}
	#absorbPending(): void {
		for (const [monitorId, checkpoint] of this.#pending) {
			const entry = this.#entries.get(monitorId);
			if (entry) this.#entries.set(monitorId, { ...entry, lastCheckpoint: checkpoint });
		}
		this.#pending.clear();
	}

	#entryFor({ monitorId, spec }: MonitorRegistration): ManifestMonitor {
		const createdAt = this.#now();
		// A spec that omits `persistent` is ephemeral: the persisted field is a boolean the
		// strict parse rejects as undefined, so coerce here rather than trusting the caller.
		const persistent = spec.persistent === true;
		return {
			monitorId,
			sessionId: this.#sessionId,
			description: spec.description,
			runtimeKind: spec.kind,
			durabilityClass: !persistent
				? "ephemeral"
				: spec.kind === "file"
					? "checkpointed-file"
					: "restartable-command",
			command: spec.kind === "command" ? spec.command : undefined,
			path: spec.kind === "file" ? spec.path : undefined,
			event: spec.kind === "file" ? spec.event : undefined,
			filter: spec.kind === "command" ? spec.filter : undefined,
			cwd: spec.cwd,
			approvedParent: spec.kind === "file" ? spec.approvedParent : undefined,
			createdAt,
			// Absolute durability deadline for every restart-surviving entry, set once here and
			// never extended by a restore or a rearm. An ephemeral entry dies with the process,
			// so its runtime deadline stays the registry's business, not the manifest's.
			expiresAt: persistent ? createdAt + DURABLE_MONITOR_EXPIRY_MS : null,
			persistent,
			suspended: false,
			lastCheckpoint: null,
			deliveryPaused: false,
			fireWindow: { startMs: createdAt, count: 0 },
		};
	}

	#persist(): Promise<void> {
		const run = this.#tail.then(() =>
			this.store.write({
				version: TERMINAL_MANIFEST_VERSION,
				sessionId: this.#sessionId,
				monitors: [...this.#entries.values()],
				backgroundSessions: [...this.#backgrounds.values()],
				updatedAt: this.#now(),
			}),
		);
		this.#tail = run.then(
			() => undefined,
			(error) => {
				this.persistFailure = error;
			},
		);
		return this.#tail;
	}
}
