/**
 * Per-session terminal manifest: the durable sidecar record of live monitors and background
 * sessions that `restore.ts` reads back after a restart. The writer persists ONLY lifecycle
 * transitions plus debounced checkpoints — never per-line output and never a runtime handle.
 */

import { join } from "node:path";
import type { SessionManager } from "../../../session-manager.ts";
import { createSidecarStore, type SidecarStore } from "../../../session-sidecar-store.ts";
import type { MonitorSnapshotEntry } from "./monitor-registry.ts";
import { parseTerminalManifest } from "./restore.ts";

export const TERMINAL_MANIFEST_VERSION = 1;
/** Minimum debounce for checkpoint writes; a burst inside this window collapses to one write. */
export const TERMINAL_MANIFEST_CHECKPOINT_DEBOUNCE_MS = 30_000;
export type TerminalManifestSession = Pick<SessionManager, "getSessionDir" | "getSessionId">;
export type MonitorRuntimeKind = "command" | "file";
export type MonitorDurabilityClass = "ephemeral" | "restartable-command" | "checkpointed-file";
/** File-monitor checkpoint persisted by the writer: the registry's live identity tuple. */
export interface TerminalManifestCheckpoint {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
}

export interface ManifestMonitor {
	readonly monitorId: string;
	/** Owning agent session id — never the bash_N/watch_N runtime id. */
	readonly sessionId: string;
	readonly description: string;
	readonly runtimeKind: MonitorRuntimeKind;
	readonly durabilityClass: MonitorDurabilityClass;
	readonly command?: string;
	readonly path?: string;
	readonly event?: "create" | "modify";
	readonly filter?: string;
	readonly cwd?: string;
	readonly approvedParent?: string;
	readonly createdAt: number;
	readonly expiresAt: number | null;
	readonly persistent: boolean;
	readonly suspended: boolean;
	readonly lastCheckpoint: TerminalManifestCheckpoint | null;
	readonly deliveryPaused: boolean;
	readonly wakeCount: number;
	readonly fireWindow: { startMs: number; count: number };
}

export interface ManifestBackgroundSession {
	readonly id: string;
	readonly command: string;
	readonly startedAtMs: number;
}

export interface TerminalManifest {
	readonly version: typeof TERMINAL_MANIFEST_VERSION;
	readonly sessionId: string;
	readonly monitors: readonly ManifestMonitor[];
	readonly backgroundSessions: readonly ManifestBackgroundSession[];
	readonly updatedAt: number;
}

/** What the monitor tool captures at its call site — the only place the branch inputs live. */
export interface CommandMonitorSpec {
	readonly kind: "command";
	readonly description: string;
	readonly command: string;
	readonly filter?: string;
	readonly cwd?: string;
	readonly persistent: boolean;
}

export interface FileMonitorSpec {
	readonly kind: "file";
	readonly description: string;
	readonly path: string;
	readonly event: "create" | "modify";
	readonly timeoutMs: number;
	readonly cwd: string;
	readonly approvedParent?: string;
}
export type MonitorSpec = CommandMonitorSpec | FileMonitorSpec;

export interface MonitorRegistration {
	readonly monitorId: string;
	readonly spec: MonitorSpec;
}

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
	 * Reconcile a registry transition snapshot (the bundle's single onChange consumer
	 * forwards it here): settle removes entries, pause/resume/rearm flips deliveryPaused.
	 * An entry missing its stable monitorId throws — never silently skipped; entries not
	 * registered through the tool call site are left alone (durability spec unknown).
	 */
	observeMonitorState(snapshot: readonly MonitorSnapshotEntry[]): Promise<void> {
		const live = new Map<string, boolean>();
		for (const entry of snapshot) {
			if (typeof entry.monitorId !== "string" || entry.monitorId.length === 0) {
				throw new Error(
					`terminal manifest writer saw a monitor snapshot entry without a stable monitorId (runtime id ${entry.id}); surfacing instead of silently skipping it`,
				);
			}
			live.set(entry.monitorId, entry.paused);
		}
		let changed = false;
		for (const [monitorId, known] of this.#entries) {
			const paused = live.get(monitorId);
			if (paused === undefined) {
				if (known.suspended) continue; // shutdown-suspended entries are expected to be absent
				this.#entries.delete(monitorId); // settle: the registry transitioned it out
				changed = true;
			} else if (known.deliveryPaused !== paused) {
				this.#entries.set(monitorId, { ...known, deliveryPaused: paused });
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
		return {
			monitorId,
			sessionId: this.#sessionId,
			description: spec.description,
			runtimeKind: spec.kind,
			durabilityClass:
				spec.kind === "file" ? "checkpointed-file" : spec.persistent ? "restartable-command" : "ephemeral",
			command: spec.kind === "command" ? spec.command : undefined,
			path: spec.kind === "file" ? spec.path : undefined,
			event: spec.kind === "file" ? spec.event : undefined,
			filter: spec.kind === "command" ? spec.filter : undefined,
			cwd: spec.cwd,
			approvedParent: spec.kind === "file" ? spec.approvedParent : undefined,
			createdAt,
			expiresAt: spec.kind === "file" ? createdAt + spec.timeoutMs : null,
			persistent: spec.kind === "command" ? spec.persistent : false,
			suspended: false,
			lastCheckpoint: null,
			deliveryPaused: false,
			wakeCount: 0,
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
