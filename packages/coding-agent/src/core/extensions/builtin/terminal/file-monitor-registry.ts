import { runAllAsyncCleanup, runAllCleanup, runFileMonitorPromiseBoundary } from "./file-monitor-cleanup.ts";
import {
	createLegacyFileMonitorContext,
	type LegacyFileMonitorContext,
	registerLegacyFileMonitor,
	settleLegacyFileMonitor,
} from "./file-monitor-legacy.ts";
import { assertDirectoryBinding, disposeFileMonitor, FileMonitorRegistrationError } from "./file-monitor-runtime.ts";
import { registerSecureFileMonitor, type SecureFileMonitorContext } from "./file-monitor-secure.ts";
import type {
	FileMonitorRearmResult,
	FileMonitorRecord,
	FileMonitorRegistryOptions,
	FileMonitorSnapshotEntry,
	RegisterFileMonitorOptions,
	SecureFileMonitorRecord,
} from "./file-monitor-types.ts";
import { type SecureFileMonitorWorkerEvent, SecureFileMonitorWorkerPool } from "./secure-file-monitor-worker.ts";
import { DEFAULT_MAX_SESSIONS } from "./shared.ts";

export type { FileMonitorRegistryDependencies } from "./file-monitor-runtime.ts";
export { FileMonitorRegistrationError } from "./file-monitor-runtime.ts";
export type {
	FileMonitorEvent,
	FileMonitorRearmResult,
	FileMonitorRegistryOptions,
	FileMonitorSnapshotEntry,
	RegisterFileMonitorOptions,
} from "./file-monitor-types.ts";

export class FileMonitorRegistry {
	readonly #records = new Map<string, FileMonitorRecord>();
	readonly #options: FileMonitorRegistryOptions;
	readonly #maxSessions: number;
	readonly #legacy: LegacyFileMonitorContext | undefined;
	readonly #secure: SecureFileMonitorContext | undefined;
	readonly #secureWorkers: SecureFileMonitorWorkerPool | undefined;
	readonly #pendingRegistrationPromises = new Set<Promise<string>>();
	#acceptingRegistrations = true;
	#nextId = 1;
	#pendingRegistrations = 0;

	constructor(options: FileMonitorRegistryOptions) {
		this.#options = options;
		this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
		this.#secureWorkers =
			options.secureWorkers ??
			(options.watch === undefined && options.poll === undefined
				? new SecureFileMonitorWorkerPool({ onError: options.onError })
				: undefined);
		this.#legacy = this.#secureWorkers
			? undefined
			: createLegacyFileMonitorContext(this.#records, options, () => `watch_${this.#nextId++}`);
		this.#secure = this.#secureWorkers
			? {
					records: this.#records,
					options,
					workers: this.#secureWorkers,
					allocateId: () => `watch_${this.#nextId++}`,
					isAccepting: () => this.#acceptingRegistrations,
					settleOutcome: (record, outcome) => this.#settleSecureOutcome(record, outcome),
				}
			: undefined;
	}

	snapshot(): readonly FileMonitorSnapshotEntry[] {
		return [...this.#records.values()].map((record) => ({
			id: record.id,
			description: record.description,
			paused: record.paused,
			startedAtMs: record.startedAtMs,
		}));
	}

	get capacityCount(): number {
		return this.#records.size + this.#pendingRegistrations;
	}

	register(options: RegisterFileMonitorOptions): string | Promise<string> {
		if (!this.#acceptingRegistrations) {
			throw new FileMonitorRegistrationError("Cannot create file monitor: registry is shutting down.");
		}
		if (this.#secureWorkers) {
			if (this.capacityCount >= this.#maxSessions) {
				throw new FileMonitorRegistrationError(
					`Cannot create file monitor: capacity ${this.#maxSessions} is already in use.`,
				);
			}
			this.#pendingRegistrations += 1;
			let tracked: Promise<string>;
			tracked = registerSecureFileMonitor(this.#secure!, options).finally(() => {
				this.#pendingRegistrations -= 1;
				this.#pendingRegistrationPromises.delete(tracked);
			});
			this.#pendingRegistrationPromises.add(tracked);
			return tracked;
		}
		return registerLegacyFileMonitor(this.#legacy!, options);
	}

	pauseAll(): string[] {
		const paused: string[] = [];
		for (const record of this.#records.values()) {
			if (record.paused) continue;
			record.paused = true;
			paused.push(record.id);
		}
		return paused;
	}

	rearm(id: string): FileMonitorRearmResult {
		const record = this.#records.get(id);
		if (!record) return "not_found";
		if (!record.paused) return "not_paused";
		record.paused = false;
		return "rearmed";
	}

	async stop(id: string): Promise<boolean> {
		const record = this.#records.get(id);
		if (!record) return false;
		if (record.backend === "legacy") settleLegacyFileMonitor(this.#legacy!, record, "watcher killed");
		else await this.#settleAsync(record, "watcher killed");
		return true;
	}

	async stopAll(): Promise<number> {
		const records = [...this.#records.values()];
		const actions: Array<() => void | Promise<void>> = records.map((record) => () => {
			if (record.backend === "legacy") {
				settleLegacyFileMonitor(this.#legacy!, record, "watcher killed", undefined, false);
			} else return this.#settleAsync(record, "watcher killed", undefined, false);
		});
		if (records.length > 0) actions.push(() => this.#options.onChange());
		await runAllAsyncCleanup(actions);
		return records.length;
	}

	dispose(): void {
		this.#acceptingRegistrations = false;
		const records = [...this.#records.values()];
		this.#records.clear();
		runAllCleanup(records.map((record) => () => this.#disposeRecord(record)));
		void this.#secureWorkers?.dispose().catch(this.#options.onError);
	}

	async teardown(): Promise<void> {
		this.#acceptingRegistrations = false;
		await Promise.allSettled([...this.#pendingRegistrationPromises]);
		const records = [...this.#records.values()];
		this.#records.clear();
		await runAllAsyncCleanup([
			...records.map((record) => async () => {
				if (record.backend === "legacy") disposeFileMonitor(record);
				else await record.registration.stop();
			}),
			async () => await this.#secureWorkers?.dispose(),
		]);
	}

	#settle(record: FileMonitorRecord, summary: string, line?: string, notifyChange = true): void {
		if (record.backend === "legacy") {
			settleLegacyFileMonitor(this.#legacy!, record, summary, line, notifyChange);
			return;
		}
		runFileMonitorPromiseBoundary(
			() => this.#settleAsync(record, summary, line, notifyChange),
			this.#options.onError,
		);
	}

	async #settleAsync(
		record: SecureFileMonitorRecord,
		summary: string,
		line?: string,
		notifyChange = true,
	): Promise<void> {
		if (record.settled) return;
		record.settled = true;
		const actions: Array<() => void | Promise<void>> = [
			() => {
				this.#records.delete(record.id);
			},
		];
		if (notifyChange) actions.push(() => this.#options.onChange());
		actions.push(() => record.registration.stop());
		if (line !== undefined && !record.paused) {
			actions.push(() => this.#options.emitLine(record.id, record.description, line));
		}
		actions.push(() =>
			this.#options.emitSummary(record.id, record.description, line === undefined ? summary : `${summary}: ${line}`),
		);
		await runAllAsyncCleanup(actions);
	}

	#disposeRecord(record: FileMonitorRecord): void {
		if (record.backend === "legacy") {
			disposeFileMonitor(record);
			return;
		}
		void record.registration.stop().catch((error) => {
			this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
		});
	}

	#settleSecureOutcome(record: SecureFileMonitorRecord, outcome: SecureFileMonitorWorkerEvent): void {
		try {
			assertDirectoryBinding(record.logicalParent, dirname(record.path), record.parentIdentity);
		} catch {
			this.#settle(record, "watcher error: approved monitor parent changed");
			return;
		}
		if (outcome.type === "error") {
			this.#settle(record, `watcher error: ${outcome.message}`);
		} else if (outcome.type === "timed_out") {
			this.#settle(record, "watcher timed_out");
		} else {
			this.#settle(record, "watcher completed", `${outcome.type} ${record.displayPath}`);
		}
	}
}

import { dirname } from "node:path";
