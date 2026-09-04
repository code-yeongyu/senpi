import { createHash, randomBytes } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { access, type FileHandle, lstat, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import { DEFAULT_DURABLE_MONITOR_FIRE_BUDGET, FIRE_BUDGET_AUTO_MUTE_SUMMARY, FIRE_BUDGET_WINDOW_MS } from "./shared.ts";
import type { MonitorDurabilityClass } from "./terminal-manifest.ts";
import { describeExit } from "./tools/spawn.ts";

export interface MonitorLineEvent {
	readonly type: "line";
	readonly id: string;
	readonly description: string;
	readonly line: string;
}

export interface MonitorSummaryEvent {
	readonly type: "summary";
	readonly id: string;
	readonly description: string;
	readonly summary: string;
}

export type MonitorEvent = MonitorLineEvent | MonitorSummaryEvent;

export type MonitorRearmResult = "rearmed" | "not_paused" | "not_found";

export interface MonitorResumeResult {
	readonly id: string;
	readonly mutedDropped: number;
}

const MONITOR_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Allocate a stable monitor identity: "mon_" + 16 Crockford base-32 chars (80 random bits). */
export function allocateMonitorId(): string {
	let id = "mon_";
	let buffer = 0;
	let bits = 0;
	for (const byte of randomBytes(10)) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			id += MONITOR_ID_ALPHABET[(buffer >> bits) & 31];
		}
	}
	return id;
}

export type MonitorFireWindow = { startMs: number; count: number };
export interface MonitorSnapshotEntry {
	readonly id: string;
	/** Stable "mon_" identity carried alongside the runtime id; always set on live snapshots. */
	readonly monitorId?: string;
	readonly description: string;
	readonly paused: boolean;
	/** Epoch milliseconds when the watch registered; feeds the footer's live elapsed label. */
	readonly startedAtMs: number;
	/** Durability deadline of a restart-surviving watch; undefined for every ephemeral one. */
	readonly expiresAt?: number;
	readonly fireWindow?: MonitorFireWindow;
}

export interface MonitorRegistryOptions {
	/** Observes every registry transition (register/pause/rearm/settle/dispose) with the live snapshot. */
	readonly onChange?: (snapshot: readonly MonitorSnapshotEntry[]) => void;
	/** Reserves one shared terminal capacity slot for a native watch. */
	readonly reserve?: () => (() => void) | null;
}

export interface RegisterFileMonitorOptions {
	readonly description: string;
	readonly path: string;
	/** Caller-supplied stable identity so a restore can re-bind the same "mon_" id. */
	readonly monitorId?: string;
	readonly event: "create" | "modify";
	readonly timeoutMs: number;
	readonly cwd: string;
	readonly approvedParent?: string;
	/** Durability deadline of a `checkpointed-file` watch; omitted for a one-shot ephemeral one. */
	readonly expiresAt?: number;
}

export interface RegisterMonitorOptions {
	readonly id: string;
	/** Caller-supplied stable identity so a restore can re-bind the same "mon_" id. */
	readonly monitorId?: string;
	readonly description: string;
	readonly runtime: TerminalRuntimeSession;
	readonly filter?: RegExp;
	/** Durability class from the manifest spec; non-ephemeral records carry the fire budget. */
	readonly durabilityClass?: MonitorDurabilityClass;
	/** Persisted fire window re-bound by a restore, so a restart cannot reset the budget. */
	readonly fireWindow?: MonitorFireWindow;
	/** Durability deadline of a durable watch; omitted for an ephemeral one. */
	readonly expiresAt?: number;
}

interface PendingFileRegistration {
	release: (() => void) | undefined;
	readonly abort: AbortController;
	readonly deadline: ReturnType<typeof setTimeout>;
	settled: boolean;
}

interface FileMonitorRecord {
	readonly id: string;
	readonly monitorId: string;
	readonly sessionId: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly expiresAt: number | undefined;
	readonly path: string;
	readonly canonicalPath: string;
	readonly canonicalParent: string;
	readonly event: "create" | "modify";
	readonly watcher: FSWatcher;
	readonly release: () => void;
	readonly poll: ReturnType<typeof setInterval>;
	paused: boolean;
	settled: boolean;
	present: boolean;
	mtimeMs: number;
	size: number;
	digest: string;
	device: number;
	inode: number;
	pendingChange: boolean;
	dirty: boolean;
	dirtyPasses: number;
	dirtyWindowStartedAt: number;
	checking: Promise<void> | undefined;
	readonly deadline: ReturnType<typeof setTimeout>;
}

interface MonitorRecord {
	readonly id: string;
	readonly monitorId: string;
	readonly sessionId: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly expiresAt: number | undefined;
	readonly runtime: TerminalRuntimeSession;
	readonly filter: RegExp | undefined;
	lineBuffer: string;
	mutedDropped: number;
	paused: boolean;
	settled: boolean;
	fireWindow: MonitorFireWindow | undefined;
	unsubscribeOutput: (() => void) | undefined;
	unsubscribeExit: (() => void) | undefined;
}

/**
 * Tracks active monitor sessions alongside the terminal manager's existing bash-id registry.
 * Output is deliberately retained only by TerminalRuntimeSession's bounded history; this
 * registry holds at most one unfinished line for each live monitor.
 */
export class MonitorRegistry {
	readonly #records = new Map<string, MonitorRecord>();
	readonly #emit: (event: MonitorEvent) => void;
	readonly #onChange: ((snapshot: readonly MonitorSnapshotEntry[]) => void) | undefined;
	readonly #reserve: (() => (() => void) | null) | undefined;
	readonly #files = new Map<string, FileMonitorRecord>();
	#nextFileId = 1;
	#disposed = false;
	#pendingRegistrations = 0;
	readonly #pending = new Set<PendingFileRegistration>();
	#lifecycle = 0;

	constructor(emit: (event: MonitorEvent) => void, options?: MonitorRegistryOptions) {
		this.#emit = emit;
		this.#onChange = options?.onChange;
		this.#reserve = options?.reserve;
	}

	snapshot(): readonly MonitorSnapshotEntry[] {
		return [...this.#records.values(), ...this.#files.values()].map((record) => ({
			id: record.id,
			monitorId: record.monitorId,
			description: record.description,
			paused: record.paused,
			startedAtMs: record.startedAtMs,
			expiresAt: record.expiresAt,
			fireWindow: "fireWindow" in record ? record.fireWindow : undefined,
		}));
	}

	async registerFile(options: RegisterFileMonitorOptions): Promise<{ id: string; monitorId: string }> {
		if (this.#disposed) throw new Error("Cannot create file monitor: monitor registry is disposed.");
		this.#pendingRegistrations += 1;
		const lifecycle = this.#lifecycle;
		const release = this.#reserve?.();
		if (this.#reserve && !release) {
			this.#pendingRegistrations -= 1;
			throw new Error("Cannot create file monitor: terminal capacity is already in use.");
		}
		const pending: PendingFileRegistration = {
			release: release ?? undefined,
			abort: new AbortController(),
			deadline: setTimeout(() => pending.abort.abort(), options.timeoutMs),
			settled: false,
		};
		this.#pending.add(pending);
		const path = resolve(options.cwd, options.path);
		const parent = dirname(path);
		let approvedParent: string;
		try {
			await this.#registrationAwait(pending, access(parent));
			approvedParent = await this.#registrationAwait(pending, realpath(parent));
			const approvedParentAtPermission = options.approvedParent;
			if (approvedParentAtPermission !== undefined && approvedParent !== approvedParentAtPermission) {
				throw new Error(`Cannot watch file: parent directory changed during permission approval: ${parent}`);
			}
			if (this.#disposed) throw new Error("Cannot create file monitor: monitor registry is disposed.");
		} catch (error) {
			this.#finishPending(pending);
			this.#pendingRegistrations -= 1;
			if (error instanceof Error && error.message.includes("disposed")) throw error;
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				throw new Error(
					`Cannot access parent directory ${parent}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			throw new Error(`Cannot watch file: parent directory does not exist: ${parent}`);
		}
		let initial: Awaited<ReturnType<typeof stat>> | null = null;
		let initialHandle: FileHandle | undefined;
		try {
			const target = await this.#registrationAwait(pending, lstat(path));
			if (target.isSymbolicLink()) throw new Error(`Cannot watch file: target is a symbolic link: ${path}`);
			initialHandle = await this.#registrationAwait(pending, open(path, "r"), async (handle) => {
				await handle.close();
			});
			initial = await this.#registrationAwait(pending, initialHandle.stat());
			if (!initial.isFile()) throw new Error(`Cannot watch file: target is not a regular file: ${path}`);
			const resolvedTarget = await this.#registrationAwait(pending, realpath(path));
			if (resolvedTarget !== join(approvedParent, basename(path)))
				throw new Error(`Cannot watch file: target identity changed: ${path}`);
			const rebound = await this.#registrationAwait(pending, lstat(path));
			if (rebound.isSymbolicLink()) throw new Error(`Cannot watch file: target identity changed: ${path}`);
			const reboundStat = await this.#registrationAwait(pending, stat(path));
			if (!reboundStat.isFile() || reboundStat.dev !== initial.dev || reboundStat.ino !== initial.ino)
				throw new Error(`Cannot watch file: target identity changed: ${path}`);
		} catch (error) {
			await initialHandle?.close();
			initialHandle = undefined;
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				this.#finishPending(pending);
				this.#pendingRegistrations -= 1;
				throw error;
			}
		}
		if (this.#disposed || lifecycle !== this.#lifecycle || this.#pendingRegistrations < 1) {
			this.#finishPending(pending);
			this.#pendingRegistrations -= 1;
			throw new Error("Cannot create file monitor: monitor registry is disposed.");
		}
		const id = `watch_${this.#nextFileId++}`;
		let watcher: FSWatcher;
		try {
			const activationParent = await this.#registrationAwait(pending, realpath(parent));
			if (activationParent !== approvedParent) {
				throw new Error(`Cannot watch file: parent directory changed during registration: ${parent}`);
			}
			watcher = watch(activationParent, (_kind, name) => {
				if (!name || basename(String(name)) === basename(path)) void this.#checkFile(id);
			});
		} catch (error) {
			this.#finishPending(pending);
			this.#pendingRegistrations -= 1;
			throw new Error(`Cannot watch file ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		let registrationError: string | undefined;
		watcher.on("error", (error) => {
			registrationError = `watcher error: ${error instanceof Error ? error.message : String(error)}`;
			const record = this.#files.get(id);
			if (record) this.#settleFile(record, registrationError);
		});
		let registrationCleaned = false;
		const finishRegistration = () => {
			if (registrationCleaned) return;
			registrationCleaned = true;
			this.#pendingRegistrations -= 1;
		};
		const cleanupRegistration = () => {
			if (registrationCleaned) return;
			watcher.close();
			finishRegistration();
			this.#finishPending(pending);
		};
		if (this.#disposed || lifecycle !== this.#lifecycle) {
			cleanupRegistration();
			throw new Error("Cannot create file monitor: monitor registry is disposed.");
		}
		const canonicalPath = join(approvedParent, basename(path));
		let digest: string;
		try {
			digest =
				initial && initialHandle
					? await this.#registrationAwait(pending, this.#digestHandle(initialHandle, pending.abort.signal))
					: "";
		} catch (error) {
			cleanupRegistration();
			await initialHandle?.close();
			initialHandle = undefined;
			if (registrationError) {
				this.#emit({ type: "summary", id, description: options.description, summary: registrationError });
				throw new Error(registrationError);
			}
			throw error;
		}
		await initialHandle?.close();
		initialHandle = undefined;
		if (registrationError) {
			cleanupRegistration();
			this.#emit({ type: "summary", id, description: options.description, summary: registrationError });
			throw new Error(registrationError);
		}
		if (this.#disposed || lifecycle !== this.#lifecycle) {
			cleanupRegistration();
			throw new Error("Cannot create file monitor: monitor registry is disposed.");
		}
		const record: FileMonitorRecord = {
			id,
			monitorId: options.monitorId ?? allocateMonitorId(),
			sessionId: id,
			description: options.description,
			startedAtMs: Date.now(),
			expiresAt: options.expiresAt,
			path,
			canonicalPath,
			canonicalParent: approvedParent,
			event: options.event,
			watcher,
			release: release ?? (() => {}),
			poll: setInterval(() => void this.#checkFile(id), 250),
			paused: false,
			settled: false,
			present: initial !== null,
			mtimeMs: initial?.mtimeMs ?? 0,
			size: initial?.size ?? 0,
			digest,
			device: initial?.dev ?? 0,
			inode: initial?.ino ?? 0,
			pendingChange: false,
			dirty: false,
			dirtyPasses: 0,
			dirtyWindowStartedAt: 0,
			checking: undefined,
			deadline: setTimeout(() => {
				const current = this.#files.get(id);
				if (current) this.#settleFile(current, "watcher timed_out");
			}, options.timeoutMs),
		};
		this.#files.set(id, record);
		finishRegistration();
		this.#finishPending(pending, true);
		if (registrationError || this.#disposed || lifecycle !== this.#lifecycle) {
			this.#settleFile(record, registrationError ?? "watcher killed");
			throw new Error(registrationError ?? "Cannot create file monitor: monitor registry is disposed.");
		}
		this.#notifyChange();
		return { id, monitorId: record.monitorId };
	}

	/** Live identity tuple of one file watch; undefined when the id is not a live file watch. */
	fileCheckpoint(id: string) {
		const r = this.#files.get(id);
		return (
			r && { dev: r.device, ino: r.inode, size: r.size, mtimeMs: r.mtimeMs, digest: r.digest, present: r.present }
		);
	}

	/** Emit one restored-watch line through the SAME sink a live watch uses (coalescing, wake budget). */
	emitFileLine(id: string, line: string): boolean {
		const record = this.#files.get(id);
		if (!record || record.settled) return false;
		this.#emit({ type: "line", id: record.id, description: record.description, line });
		return true;
	}

	async stopFile(id: string): Promise<boolean> {
		const record = this.#files.get(id);
		if (!record) return false;
		this.#settleFile(record, "watcher killed");
		return true;
	}

	async stopAllFiles(): Promise<number> {
		this.#lifecycle += 1;
		const records = [...this.#files.values()];
		for (const record of records) this.#settleFile(record, "watcher killed");
		for (const pending of [...this.#pending]) this.#finishPending(pending);
		return records.length;
	}

	#settleFile(record: FileMonitorRecord, summary: string): void {
		if (record.settled) return;
		record.settled = true;
		clearInterval(record.poll);
		clearTimeout(record.deadline);
		record.watcher.close();
		record.release();
		this.#files.delete(record.id);
		this.#notifyChange();
		this.#emit({ type: "summary", id: record.id, description: record.description, summary });
	}

	async #checkFile(id: string): Promise<void> {
		const record = this.#files.get(id);
		if (!record || record.settled) return;
		if (record.checking) {
			record.dirty = true;
			return;
		}
		record.checking = this.#checkFileImpl(record)
			.catch((error) => {
				if (!record.settled)
					this.#settleFile(record, `watcher error: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				record.checking = undefined;
				const now = Date.now();
				if (now - record.dirtyWindowStartedAt >= 1_000) {
					record.dirtyWindowStartedAt = now;
					record.dirtyPasses = 0;
				}
				if (record.dirty && !record.settled && record.dirtyPasses < 1) {
					record.dirty = false;
					record.dirtyPasses += 1;
					void this.#checkFile(id);
				} else {
					record.dirty = false;
				}
			});
		return record.checking;
	}

	async #checkFileImpl(record: FileMonitorRecord): Promise<void> {
		if (record.settled) return;
		let current: Awaited<ReturnType<typeof stat>> | null = null;
		let handle: FileHandle | undefined;
		try {
			const currentParent = await realpath(dirname(record.path));
			if (currentParent !== record.canonicalParent) {
				this.#settleFile(record, `watcher error: monitored parent changed: ${dirname(record.path)}`);
				return;
			}
			const target = await lstat(record.canonicalPath);
			if (target.isSymbolicLink()) throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
			const resolvedTarget = await realpath(record.canonicalPath);
			if (resolvedTarget !== record.canonicalPath)
				throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
			handle = await open(record.canonicalPath, "r");
			const opened = await handle.stat();
			if (!opened.isFile()) throw new Error(`Cannot watch file: target is not a regular file: ${record.path}`);
			if ((opened.dev !== record.device || opened.ino !== record.inode) && opened.nlink > 1)
				throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
			current = opened;
			const rebound = await lstat(record.canonicalPath);
			if (rebound.isSymbolicLink()) throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
			const reboundPath = await stat(record.canonicalPath);
			if (!reboundPath.isFile() || reboundPath.dev !== opened.dev || reboundPath.ino !== opened.ino)
				throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
		} catch (error) {
			await handle?.close();
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				this.#settleFile(record, `watcher error: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		}
		const present = current !== null;
		let digest = "";
		try {
			digest = present && handle ? await this.#digestHandle(handle) : "";
			if (present && handle) {
				const afterDigest = await stat(record.canonicalPath);
				const opened = await handle.stat();
				if (afterDigest.dev !== opened.dev || afterDigest.ino !== opened.ino)
					throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
			}
		} finally {
			await handle?.close();
		}
		const changed =
			record.event === "create"
				? !record.present && present
				: record.present &&
					present &&
					(current!.mtimeMs !== record.mtimeMs || current!.size !== record.size || digest !== record.digest);
		record.pendingChange ||= changed;
		if (!record.present && current) {
			record.device = current.dev;
			record.inode = current.ino;
		}
		record.present = present;
		record.mtimeMs = current?.mtimeMs ?? 0;
		record.size = current?.size ?? 0;
		record.digest = digest;
		if (!record.pendingChange || record.paused || record.settled) return;
		record.pendingChange = false;
		if (record.settled) return;
		this.#emit({
			type: "line",
			id: record.id,
			description: record.description,
			line: `${record.event} ${record.path}`,
		});
		this.#settleFile(record, "watcher completed");
	}

	register(options: RegisterMonitorOptions): string {
		const durable = options.durabilityClass !== undefined && options.durabilityClass !== "ephemeral";
		const record: MonitorRecord = {
			id: options.id,
			monitorId: options.monitorId ?? allocateMonitorId(),
			sessionId: options.id,
			description: options.description,
			startedAtMs: Date.now(),
			expiresAt: options.expiresAt,
			runtime: options.runtime,
			filter: options.filter,
			lineBuffer: "",
			mutedDropped: 0,
			paused: false,
			settled: false,
			fireWindow: durable ? { ...(options.fireWindow ?? { startMs: Date.now(), count: 0 }) } : undefined,
			unsubscribeOutput: undefined,
			unsubscribeExit: undefined,
		};
		this.#records.set(record.id, record);
		this.#notifyChange();

		// Runtime output is already bounded. Read what was produced before monitor registration,
		// then subscribe synchronously so a fast watcher cannot lose its first line.
		this.#consume(record, record.runtime.fullOutput());
		record.unsubscribeOutput = record.runtime.onOutput((chunk) => this.#consume(record, chunk));
		record.unsubscribeExit = record.runtime.session.onExit(() => this.#settle(record));
		if (record.runtime.exited) this.#settle(record);
		return record.monitorId;
	}

	pause(ids: readonly string[]): string[] {
		const paused: string[] = [];
		for (const id of ids) {
			const record = this.#records.get(id) ?? this.#files.get(id);
			if (!record || record.paused) continue;
			record.paused = true;
			paused.push(record.id);
		}
		if (paused.length > 0) this.#notifyChange();
		return paused;
	}

	pauseAll(): string[] {
		return this.pause([...this.#records.keys(), ...this.#files.keys()]);
	}

	resume(ids?: readonly string[]): MonitorResumeResult[] {
		const candidates = ids ?? [...this.#records.keys(), ...this.#files.keys()];
		const resumed: MonitorResumeResult[] = [];
		for (const id of candidates) {
			const record = this.#records.get(id) ?? this.#files.get(id);
			if (!record?.paused) continue;
			record.paused = false;
			const mutedDropped = "mutedDropped" in record ? record.mutedDropped : 0;
			if ("mutedDropped" in record) record.mutedDropped = 0;
			// A rearm (or any resume) restarts the rolling fire budget while keeping its window start.
			if ("fireWindow" in record && record.fireWindow !== undefined) record.fireWindow.count = 0;
			resumed.push({ id: record.id, mutedDropped });
			if ("pendingChange" in record && record.pendingChange) void this.#checkFile(record.id);
		}
		if (resumed.length > 0) this.#notifyChange();
		return resumed;
	}

	mutedDropped(id: string): number {
		return this.#records.get(id)?.mutedDropped ?? 0;
	}

	rearm(id: string): MonitorRearmResult {
		const record = this.#records.get(id) ?? this.#files.get(id);
		if (!record) return "not_found";
		if (!record.paused) return "not_paused";
		this.resume([id]);
		return "rearmed";
	}

	/** Re-bind a persisted fire window onto the record for a durable monitor id (a restore re-arms the budget). */
	adoptFireWindow(monitorId: string, fireWindow: MonitorFireWindow): boolean {
		for (const record of this.#records.values()) {
			if (record.monitorId !== monitorId) continue;
			record.fireWindow = { ...fireWindow };
			return true;
		}
		return false;
	}

	dispose(): void {
		this.#disposed = true;
		this.#lifecycle += 1;
		for (const record of this.#records.values()) this.#disposeRecord(record);
		for (const record of this.#files.values()) this.#settleFile(record, "watcher disposed");
		for (const pending of this.#pending) this.#finishPending(pending);
		this.#records.clear();
		this.#notifyChange();
	}

	#finishPending(pending: PendingFileRegistration, transfer = false): void {
		if (pending.settled) return;
		pending.settled = true;
		clearTimeout(pending.deadline);
		this.#pending.delete(pending);
		if (transfer) pending.release = undefined;
		else {
			pending.abort.abort();
			pending.release?.();
		}
	}

	async #registrationAwait<T>(
		pending: PendingFileRegistration,
		operation: Promise<T>,
		lateCleanup?: (value: T) => Promise<void>,
	): Promise<T> {
		if (pending.abort.signal.aborted) {
			void operation.then(
				(value) => lateCleanup?.(value),
				() => undefined,
			);
			throw new Error("Cannot create file monitor: registration timed out or was disposed.");
		}
		let aborted = false;
		const abort = new Promise<never>((_, reject) =>
			pending.abort.signal.addEventListener(
				"abort",
				() => {
					aborted = true;
					reject(new Error("Cannot create file monitor: registration timed out or was disposed."));
				},
				{ once: true },
			),
		);
		const guarded = operation.then(
			(value) => {
				if (aborted) void lateCleanup?.(value);
				return value;
			},
			(error) => {
				if (aborted) return undefined as T;
				throw error;
			},
		);
		return Promise.race([guarded, abort]);
	}

	async #digestHandle(handle: FileHandle, signal?: AbortSignal): Promise<string> {
		const SAMPLE_SIZE = 64 * 1024;
		if (signal?.aborted) throw new Error("file monitor registration cancelled");
		const metadata = await handle.stat();
		const hash = createHash("sha256");
		const first = Buffer.alloc(Math.min(SAMPLE_SIZE, metadata.size));
		if (first.length > 0) {
			await handle.read(first, 0, first.length, 0);
			hash.update(first);
		}
		if (metadata.size > SAMPLE_SIZE) {
			const middle = Buffer.alloc(SAMPLE_SIZE);
			await handle.read(middle, 0, middle.length, Math.floor((metadata.size - middle.length) / 2));
			hash.update(middle);
			const last = Buffer.alloc(SAMPLE_SIZE);
			await handle.read(last, 0, last.length, metadata.size - last.length);
			hash.update(last);
		}
		return `${metadata.size}:${hash.digest("hex")}`;
	}

	#notifyChange(): void {
		this.#onChange?.(this.snapshot());
	}

	#consume(record: MonitorRecord, chunk: string): void {
		if (record.settled || chunk.length === 0) return;
		let remaining = record.lineBuffer + chunk;
		for (;;) {
			const newline = remaining.indexOf("\n");
			if (newline < 0) break;
			const rawLine = remaining.slice(0, newline);
			remaining = remaining.slice(newline + 1);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			const matchesFilter = !record.filter || record.filter.test(line);
			if (!matchesFilter) continue;
			if (record.paused) {
				record.mutedDropped += 1;
				continue;
			}
			this.#emit({ type: "line", id: record.id, description: record.description, line });
			if (record.fireWindow !== undefined) {
				const now = Date.now();
				if (now - record.fireWindow.startMs >= FIRE_BUDGET_WINDOW_MS)
					record.fireWindow = { startMs: now, count: 0 };
				record.fireWindow.count += 1;
				if (record.fireWindow.count >= DEFAULT_DURABLE_MONITOR_FIRE_BUDGET) {
					record.paused = true;
					this.#emit({
						type: "summary",
						id: record.id,
						description: record.description,
						summary: FIRE_BUDGET_AUTO_MUTE_SUMMARY,
					});
					this.#notifyChange();
				}
			}
		}
		record.lineBuffer = remaining;
	}

	#settle(record: MonitorRecord): void {
		if (record.settled) return;
		record.settled = true;
		record.unsubscribeOutput?.();
		record.unsubscribeExit?.();
		this.#records.delete(record.id);
		this.#notifyChange();
		const status = describeExit(record.runtime) ?? "exited";
		const code = record.runtime.exitResult?.exitCode;
		const codeText = code === null || code === undefined ? "" : ` (exit code ${code})`;
		this.#emit({
			type: "summary",
			id: record.id,
			description: record.description,
			summary: `watcher ${status}${codeText}`,
		});
	}

	#disposeRecord(record: MonitorRecord): void {
		record.settled = true;
		record.unsubscribeOutput?.();
		record.unsubscribeExit?.();
	}
}
