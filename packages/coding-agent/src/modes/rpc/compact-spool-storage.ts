import { join } from "node:path";
import { CompactReadError } from "./compact-read-lease.ts";
import { createSpoolDir, removeSpoolDir } from "./compact-spool-dir.ts";
import {
	type CompactStorageFailure,
	type CompactStorageIo,
	type CompactStorageOperation,
	CompactStorageReadError,
	describeCause,
} from "./compact-storage-io.ts";

/**
 * The spool file path of compact current-state storage (senpi#4272, R3.C6.4): one serial
 * asynchronous job chain, the private epoch directory, spool file writes, reads and reclamation,
 * and the failure ledger. `CompactContentStore` adds leaf ownership and spilling on top.
 */

export const RECLAIM_WORK_ALLOWANCE_BYTES = 1024 * 1024;
const RECLAIM_RETRY_DELAYS_MS = [100, 400, 1_600, 6_400, 25_600];
const FAILURE_HISTORY = 32;

export abstract class CompactSpoolStorage {
	readonly dir: string;
	private readonly io: CompactStorageIo;
	protected readonly failures: CompactStorageFailure[] = [];
	private nextFile = 1;
	private dirReady: Promise<string | undefined> | undefined;
	private spoolToken: string | undefined;
	private chain: Promise<void> = Promise.resolve();
	private queued = 0;
	protected spillQueued = false;
	private halted = false;
	protected retired = false;
	protected pendingIoCopyBytes = 0;
	protected spillBytesWritten = 0;
	protected reclaimDebtBytes = 0;
	private reads = 0;
	private reading: ReturnType<typeof Promise.withResolvers<void>> | undefined;

	assertReadable(): void {
		if (this.retired) throw new CompactReadError("retired");
	}

	beginRead(): () => void {
		this.assertReadable();
		this.reads++;
		this.reading ??= Promise.withResolvers<void>();
		let done = false;
		return () => {
			if (done) return;
			done = true;
			if (--this.reads === 0) {
				this.reading?.resolve();
				this.reading = undefined;
			}
		};
	}

	constructor(dir: string, io: CompactStorageIo) {
		this.dir = dir;
		this.io = io;
	}

	/** Resolves once every queued storage job, including the ones they queued, has completed. */
	async idle(): Promise<void> {
		while (this.queued > 0) await this.chain;
	}

	/**
	 * Invalidates spilling, joins owned I/O, then removes the epoch directory only when this store
	 * created it and it still passes the ownership checks; otherwise rejects with `CompactSpoolRefusedError`.
	 */
	async retire(): Promise<void> {
		this.retired = true;
		await this.reading?.promise;
		await this.idle();
		const token = this.spoolToken;
		this.spoolToken = undefined;
		if (token !== undefined) await removeSpoolDir(this.dir, token);
	}

	/** Reads a committed file and rejects a missing, unreadable or short one. */
	async readFile(path: string, bytes: number, operation: CompactStorageOperation): Promise<Buffer> {
		const done = this.beginRead();
		try {
			const result = await this.readCommittedFile(path, bytes, operation);
			this.assertReadable();
			return result;
		} finally {
			done();
		}
	}

	private async readCommittedFile(path: string, bytes: number, operation: CompactStorageOperation): Promise<Buffer> {
		let data: Buffer;
		try {
			data = await this.io.readFile(path);
		} catch (cause) {
			throw this.readFailure(operation, path, cause);
		}
		if (data.byteLength !== bytes) {
			throw this.readFailure(operation, path, new Error(`expected ${bytes} bytes, found ${data.byteLength}`));
		}
		return data;
	}

	/** Writes one new spool file; undefined means the write failed and was reported (a spill write also halts spilling). */
	async writeFile(
		data: Buffer,
		operation: CompactStorageOperation,
		retainedInMemoryBytes: number,
	): Promise<string | undefined> {
		const path = await this.ensureDir(retainedInMemoryBytes);
		if (path === undefined) return undefined;
		const file = join(path, `${operation === "spill_write" ? "leaf" : "page"}-${this.nextFile++}.bin`);
		this.pendingIoCopyBytes += data.byteLength;
		try {
			await this.io.writeFile(file, data);
			this.spillBytesWritten += data.byteLength;
			return file;
		} catch (cause) {
			try {
				this.fail(operation, file, cause, retainedInMemoryBytes);
			} finally {
				this.discard(file, data.byteLength);
			}
			return undefined;
		} finally {
			this.pendingIoCopyBytes -= data.byteLength;
		}
	}

	/**
	 * An unreferenced (or partially written) spool file: reclamation debt until its unlink completes or
	 * finds it gone. Files dropped after retirement started belong to the directory retirement removes.
	 */
	discard(path: string, bytes: number): void {
		if (this.retired) return;
		this.reclaimDebtBytes += bytes;
		this.enqueue("reclaim", () => this.reclaim(path, bytes, 0));
	}

	/** A failed unlink keeps its debt and is retried with bounded backoff outside the job chain. */
	private async reclaim(path: string, bytes: number, attempt: number): Promise<void> {
		try {
			await this.io.unlink(path);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
				this.fail("reclaim", path, cause, 0);
				const delay = RECLAIM_RETRY_DELAYS_MS[attempt];
				if (delay !== undefined) {
					setTimeout(() => {
						if (this.retired) this.reclaimDebtBytes -= bytes;
						else this.enqueue("reclaim", () => this.reclaim(path, bytes, attempt + 1));
					}, delay).unref?.();
				}
				return;
			}
		}
		this.reclaimDebtBytes -= bytes;
		this.scheduleSpill();
	}

	get spillAllowed(): boolean {
		return !this.halted && !this.retired;
	}

	/** True while a storage failure or unreclaimed debt above the work allowance holds spilling back. */
	protected get spillStopped(): boolean {
		return this.halted || this.reclaimDebtBytes > RECLAIM_WORK_ALLOWANCE_BYTES;
	}

	enqueue(operation: CompactStorageOperation, job: () => Promise<void>): void {
		this.queued++;
		this.chain = this.chain
			.then(job)
			.catch((cause: unknown) => {
				if (operation === "spill_write") this.spillQueued = false;
				this.fail(operation, this.dir, cause, 0);
			})
			.finally(() => {
				this.queued--;
			});
	}

	protected abstract scheduleSpill(): void;

	/** Creates the private epoch directory once; a refusal or failure halts spilling and is reported. */
	private ensureDir(retained: number): Promise<string | undefined> {
		this.dirReady ??= createSpoolDir(this.dir).then(
			(token) => {
				this.spoolToken = token;
				return this.dir;
			},
			(cause: unknown) => {
				this.fail("spool_create", this.dir, cause, retained);
				return undefined;
			},
		);
		return this.dirReady;
	}

	private readFailure(operation: CompactStorageOperation, path: string, cause: unknown): CompactStorageReadError {
		this.fail(operation, path, cause, 0);
		return new CompactStorageReadError(operation, path, cause);
	}

	private fail(operation: CompactStorageOperation, path: string, cause: unknown, retained: number): void {
		if (operation === "spill_write" || operation === "spool_create") this.halted = true;
		this.record({ operation, path, cause: describeCause(cause), retainedInMemoryBytes: retained });
	}

	private record(failure: CompactStorageFailure): void {
		this.failures.push(failure);
		if (this.failures.length > FAILURE_HISTORY) this.failures.shift();
	}
}
