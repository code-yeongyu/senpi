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
import { DURABLE_MONITOR_EXPIRY_MS } from "./shared.ts";

export const TERMINAL_MANIFEST_VERSION = 1;
/** Minimum debounce for checkpoint writes; a burst inside this window collapses to one write. */
export const TERMINAL_MANIFEST_CHECKPOINT_DEBOUNCE_MS = 30_000;
/**
 * Re-exported so manifest consumers read one durability deadline. The value lives in
 * `shared.ts` with the rest of the terminal caps; there is exactly one definition of it.
 */
export { DURABLE_MONITOR_EXPIRY_MS };
export type TerminalManifestSession = Pick<SessionManager, "getSessionDir" | "getSessionId">;
export type MonitorRuntimeKind = "command" | "file";
export type MonitorDurabilityClass = "ephemeral" | "restartable-command" | "checkpointed-file";
/**
 * File-monitor checkpoint persisted by the writer: the registry's live identity tuple. `digest`
 * is required — without it a same-size, same-mtime rewrite is undetectable across a restart.
 */
export interface TerminalManifestCheckpoint {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly digest: string;
	readonly present: boolean;
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
	/** Persistent file watches are the durable `checkpointed-file` class; one-shot ones stay ephemeral. */
	readonly persistent: boolean;
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
