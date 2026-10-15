/**
 * File watches: one regular file under a parent directory that must exist, watched natively and fired
 * once on create or modify. Registration proves the target's identity without blocking on a wedged
 * mount (every await races the registration deadline), and every check re-proves it.
 */
import { type FSWatcher, watch } from "node:fs";
import { access, type FileHandle, lstat, open, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalWatchPath, probeDirectoryOpenable } from "../../../../utils/fs-watch.ts";
import { realpathWithoutOpen } from "../../../../utils/paths.ts";
import { digestFileHandle } from "./monitor-file-digest.ts";
import { FileWatchLoop } from "./monitor-file-watch.ts";
import { allocateMonitorId, type MonitorRecordBase, type MonitorSourceHost } from "./monitor-types.ts";

export interface RegisterFileMonitorOptions {
	readonly description: string;
	readonly path: string;
	readonly persistent?: boolean;
	readonly deadlineMs?: number | null;
	/** Caller-supplied stable identity so a restore can re-bind the same "mon_" id. */
	readonly monitorId?: string;
	readonly event: "create" | "modify";
	readonly timeoutMs: number;
	readonly cwd: string;
	readonly approvedParent?: string;
	/** Durability deadline of a `checkpointed-file` watch; omitted for a one-shot ephemeral one. */
	readonly expiresAt?: number;
}

interface PendingFileRegistration {
	release: (() => void) | undefined;
	readonly abort: AbortController;
	readonly deadline: ReturnType<typeof setTimeout>;
	settled: boolean;
}

export interface FileMonitorRecord extends MonitorRecordBase {
	readonly id: string;
	readonly monitorId: string;
	readonly sessionId: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly command: null;
	readonly filter: null;
	readonly persistent: boolean;
	readonly deadlineMs: number | null;
	fireCount: number;
	lastFiredAtMs: number | null;
	readonly expiresAt: number | undefined;
	readonly path: string;
	readonly canonicalPath: string;
	readonly canonicalParent: string;
	readonly event: "create" | "modify";
	readonly watcher: FSWatcher;
	readonly release: () => void;
	readonly watch: FileWatchLoop;
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
	/** Unset for a persistent watch: it has no live deadline, only its durability expiry. */
	readonly deadline: ReturnType<typeof setTimeout> | undefined;
}

export class FileMonitorSource {
	readonly #files = new Map<string, FileMonitorRecord>();
	readonly #pending = new Set<PendingFileRegistration>();
	readonly #host: MonitorSourceHost;
	readonly #reserve: (() => (() => void) | null) | undefined;
	#nextFileId = 1;
	#disposed = false;
	#parked = false;
	#pendingRegistrations = 0;
	#lifecycle = 0;

	constructor(host: MonitorSourceHost, reserve: (() => (() => void) | null) | undefined) {
		this.#host = host;
		this.#reserve = reserve;
	}

	get(id: string): FileMonitorRecord | undefined {
		return this.#files.get(id);
	}

	values(): IterableIterator<FileMonitorRecord> {
		return this.#files.values();
	}

	keys(): IterableIterator<string> {
		return this.#files.keys();
	}

	/** Attachment parking is independent of persisted monitor mute and wake budgets. */
	setParked(parked: boolean): void {
		this.#parked = parked;
		for (const record of this.#files.values()) {
			if (parked) record.watch.pause();
			else if (!record.paused) record.watch.resume();
		}
	}

	get parked(): boolean {
		return this.#parked;
	}

	dispose(): void {
		this.#disposed = true;
		this.#lifecycle += 1;
		for (const record of this.#files.values()) this.#settleFile(record, "watcher disposed");
		for (const pending of this.#pending) this.#finishPending(pending);
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
			// Identity is derived without open(2), with the same walker the permission parser used, so the
			// two sides agree byte-for-byte and neither can block on a wedged mount.
			approvedParent = realpathWithoutOpen(parent);
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
			const resolvedTarget = realpathWithoutOpen(path);
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
			const activationParent = realpathWithoutOpen(parent);
			if (activationParent !== approvedParent) {
				throw new Error(`Cannot watch file: parent directory changed during registration: ${parent}`);
			}
			// watch() opens the directory synchronously on this thread; prove the open completes on the
			// async pool first so a wedged mount fails at the registration deadline instead of freezing.
			await this.#registrationAwait(pending, probeDirectoryOpenable(activationParent));
			watcher = watch(canonicalWatchPath(activationParent), (_kind, name) => {
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
				this.#host.emitRaw({ type: "summary", id, description: options.description, summary: registrationError });
				throw new Error(registrationError);
			}
			throw error;
		}
		await initialHandle?.close();
		initialHandle = undefined;
		if (registrationError) {
			cleanupRegistration();
			this.#host.emitRaw({ type: "summary", id, description: options.description, summary: registrationError });
			throw new Error(registrationError);
		}
		if (this.#disposed || lifecycle !== this.#lifecycle) {
			cleanupRegistration();
			throw new Error("Cannot create file monitor: monitor registry is disposed.");
		}
		const persistent = options.persistent ?? options.expiresAt !== undefined;
		const record: FileMonitorRecord = {
			id,
			monitorId: options.monitorId ?? allocateMonitorId(),
			sessionId: id,
			description: options.description,
			startedAtMs: Date.now(),
			command: null,
			filter: null,
			persistent,
			deadlineMs: persistent ? null : (options.deadlineMs ?? Date.now() + options.timeoutMs),
			fireCount: 0,
			lastFiredAtMs: null,
			expiresAt: options.expiresAt,
			path,
			canonicalPath,
			canonicalParent: approvedParent,
			event: options.event,
			watcher,
			release: release ?? (() => {}),
			watch: new FileWatchLoop(() => void this.#checkFile(id)),
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
			deadline: persistent
				? undefined
				: setTimeout(() => {
						const current = this.#files.get(id);
						if (current) this.#settleFile(current, "watcher timed_out");
					}, options.timeoutMs),
		};
		this.#files.set(id, record);
		if (this.#parked) record.watch.pause();
		finishRegistration();
		this.#finishPending(pending, true);
		if (registrationError || this.#disposed || lifecycle !== this.#lifecycle) {
			this.#settleFile(record, registrationError ?? "watcher killed");
			throw new Error(registrationError ?? "Cannot create file monitor: monitor registry is disposed.");
		}
		this.#host.changed();
		return { id, monitorId: record.monitorId };
	}

	/** Live identity tuple of one file watch; undefined when the id is not a live file watch. */
	fileCheckpoint(id: string) {
		const r = this.#files.get(id);
		return (
			r && { dev: r.device, ino: r.inode, size: r.size, mtimeMs: r.mtimeMs, digest: r.digest, present: r.present }
		);
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
		record.watch.stop();
		clearTimeout(record.deadline);
		record.watcher.close();
		record.release();
		this.#files.delete(record.id);
		this.#host.changed();
		this.#host.emit(record, { type: "summary", id: record.id, description: record.description, summary });
		const reason =
			summary === "watcher timed_out"
				? "timeout"
				: summary === "watcher killed"
					? "killed"
					: summary === "watcher disposed"
						? "disposed"
						: "exit";
		this.#host.ended(record, reason, null);
	}

	async #checkFile(id: string): Promise<void> {
		const record = this.#files.get(id);
		if (!record || record.settled || record.paused || this.#parked) return;
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
			const currentParent = realpathWithoutOpen(dirname(record.path));
			if (currentParent !== record.canonicalParent) {
				this.#settleFile(record, `watcher error: monitored parent changed: ${dirname(record.path)}`);
				return;
			}
			const target = await lstat(record.canonicalPath);
			if (target.isSymbolicLink()) throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
			const resolvedTarget = realpathWithoutOpen(record.canonicalPath);
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
		this.#host.emit(record, {
			type: "line",
			id: record.id,
			description: record.description,
			line: `${record.event} ${record.path}`,
		});
		this.#settleFile(record, "watcher completed");
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
		return digestFileHandle(handle, signal);
	}
}
