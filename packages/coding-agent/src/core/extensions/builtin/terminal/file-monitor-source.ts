/**
 * File watches: one regular file under a parent directory that must exist, watched natively and fired
 * once on create or modify. Registration proves the target's identity without blocking on a wedged
 * mount (every await races the registration deadline), and every check re-proves it.
 */
import { type FSWatcher, watch } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { canonicalWatchPath, probeDirectoryOpenable } from "../../../../utils/fs-watch.ts";
import { realpathWithoutOpen } from "../../../../utils/paths.ts";
import { checkFileOnce } from "./file-monitor-check.ts";
import { RegistrationGuard } from "./file-monitor-guard.ts";
import { type FileMonitorRecord, newFileRecord, type RegisterFileMonitorOptions } from "./file-monitor-record.ts";
import { proveWatchTarget, type WatchTarget } from "./file-monitor-registration.ts";
import { digestFileHandle } from "./monitor-file-digest.ts";
import type { MonitorSourceHost } from "./monitor-types.ts";

export type { FileMonitorRecord, RegisterFileMonitorOptions } from "./file-monitor-record.ts";

export class FileMonitorSource {
	readonly #files = new Map<string, FileMonitorRecord>();
	readonly #guard = new RegistrationGuard();
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
		this.#guard.finishAll();
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
		const pending = this.#guard.open(release ?? undefined, options.timeoutMs);
		let target: WatchTarget;
		try {
			target = await proveWatchTarget(this.#guard, pending, options, () => this.#disposed);
		} catch (error) {
			this.#guard.finish(pending);
			this.#pendingRegistrations -= 1;
			throw error;
		}
		const { path, parent, approvedParent, initial } = target;
		let initialHandle = target.initialHandle;
		if (this.#disposed || lifecycle !== this.#lifecycle || this.#pendingRegistrations < 1) {
			this.#guard.finish(pending);
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
			await this.#guard.await(pending, probeDirectoryOpenable(activationParent));
			watcher = watch(canonicalWatchPath(activationParent), (_kind, name) => {
				if (!name || basename(String(name)) === basename(path)) void this.#checkFile(id);
			});
		} catch (error) {
			this.#guard.finish(pending);
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
			this.#guard.finish(pending);
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
					? await this.#guard.await(pending, this.#digestHandle(initialHandle, pending.abort.signal))
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
		const record = newFileRecord({
			id,
			options,
			path,
			canonicalPath,
			approvedParent,
			watcher,
			release: release ?? undefined,
			digest,
			initial,
			check: () => void this.#checkFile(id),
			timedOut: () => {
				const current = this.#files.get(id);
				if (current) this.#settleFile(current, "watcher timed_out");
			},
		});
		this.#files.set(id, record);
		if (this.#parked) record.watch.pause();
		finishRegistration();
		this.#guard.finish(pending, true);
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
		this.#guard.finishAll();
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
		record.checking = checkFileOnce(record, {
			settle: (summary) => this.#settleFile(record, summary),
			fire: (line) => {
				this.#host.emit(record, { type: "line", id: record.id, description: record.description, line });
				this.#settleFile(record, "watcher completed");
			},
		})
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

	async #digestHandle(handle: FileHandle, signal?: AbortSignal): Promise<string> {
		return digestFileHandle(handle, signal);
	}
}
