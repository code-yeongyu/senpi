import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { SecureFileMonitorWorkerConnection } from "./secure-file-monitor-worker-connection.ts";
import type {
	RegisterSecureFileMonitorOptions,
	SecureFileMonitorWorkerPoolOptions,
	SecureFileMonitorWorkerRegistration,
} from "./secure-file-monitor-worker-protocol.ts";

export type {
	SecureFileMonitorWorkerEvent,
	SecureFileMonitorWorkerRegistration,
} from "./secure-file-monitor-worker-protocol.ts";

type WorkerEntry = {
	readonly connection: SecureFileMonitorWorkerConnection;
	closing: boolean;
	leases: number;
};

export class SecureFileMonitorWorkerPool {
	readonly #options: SecureFileMonitorWorkerPoolOptions;
	readonly #workers = new Map<string, Promise<WorkerEntry>>();
	#closed = false;

	constructor(options: SecureFileMonitorWorkerPoolOptions = {}) {
		this.#options = options;
	}

	get workerCount(): number {
		return this.#workers.size;
	}

	async register(options: RegisterSecureFileMonitorOptions): Promise<SecureFileMonitorWorkerRegistration> {
		const key = `${options.expectedDevice}:${options.expectedInode}`;
		const { entry, pending } = await this.#acquireLease(key, options);
		let registration: SecureFileMonitorWorkerRegistration;
		try {
			registration = await entry.connection.register({
				targetName: options.targetName,
				event: options.event,
				timeoutMs: options.timeoutMs,
				onEvent: options.onEvent,
			});
		} catch (error) {
			await this.#releaseLease(key, pending, entry);
			throw error;
		}
		let released = false;
		return {
			reconcile: () => registration.reconcile(),
			stop: async () => {
				if (released) return;
				released = true;
				try {
					await registration.stop();
				} finally {
					await this.#releaseLease(key, pending, entry);
				}
			},
		};
	}

	async dispose(): Promise<void> {
		this.#closed = true;
		const pending = [...this.#workers.values()];
		this.#workers.clear();
		const entries = await Promise.allSettled(pending);
		await Promise.all(
			entries.flatMap((result) => {
				if (result.status !== "fulfilled") return [];
				result.value.closing = true;
				return [result.value.connection.dispose()];
			}),
		);
	}

	async #acquireLease(
		key: string,
		options: RegisterSecureFileMonitorOptions,
	): Promise<{ readonly entry: WorkerEntry; readonly pending: Promise<WorkerEntry> }> {
		for (;;) {
			if (this.#closed) throw new Error("Secure file monitor worker pool is closed.");
			let pending = this.#workers.get(key);
			if (!pending) {
				pending = this.#createWorker(options);
				this.#workers.set(key, pending);
				void pending.catch(() => {
					if (this.#workers.get(key) === pending) this.#workers.delete(key);
				});
			}
			const entry = await pending;
			if (this.#closed) throw new Error("Secure file monitor worker pool is closed.");
			if (entry.closing || this.#workers.get(key) !== pending) continue;
			entry.leases += 1;
			return { entry, pending };
		}
	}

	async #createWorker(options: RegisterSecureFileMonitorOptions): Promise<WorkerEntry> {
		const flags =
			constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const fd = openSync(options.directory, flags);
		let connection: SecureFileMonitorWorkerConnection | undefined;
		try {
			const identity = fstatSync(fd, { bigint: true });
			if (identity.dev !== options.expectedDevice || identity.ino !== options.expectedInode) {
				throw new Error("The approved monitor parent changed before secure worker startup.");
			}
			connection = new SecureFileMonitorWorkerConnection(options.directory, this.#options);
			await connection.verify(options.expectedDevice, options.expectedInode);
			return { connection, closing: false, leases: 0 };
		} catch (error) {
			await connection?.dispose();
			throw error;
		} finally {
			closeSync(fd);
		}
	}

	async #releaseLease(key: string, pending: Promise<WorkerEntry>, entry: WorkerEntry): Promise<void> {
		entry.leases -= 1;
		if (entry.leases > 0 || entry.closing) return;
		entry.closing = true;
		if (this.#workers.get(key) === pending) this.#workers.delete(key);
		await entry.connection.dispose();
	}
}
