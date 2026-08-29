import { basename, dirname } from "node:path";
import { assertDirectoryBinding, FileMonitorRegistrationError } from "./file-monitor-runtime.ts";
import type {
	FileMonitorRecord,
	FileMonitorRegistryOptions,
	RegisterFileMonitorOptions,
	SecureFileMonitorRecord,
} from "./file-monitor-types.ts";
import type { SecureFileMonitorWorkerEvent, SecureFileMonitorWorkerPool } from "./secure-file-monitor-worker.ts";

export interface SecureFileMonitorContext {
	readonly records: Map<string, FileMonitorRecord>;
	readonly options: FileMonitorRegistryOptions;
	readonly workers: SecureFileMonitorWorkerPool;
	readonly allocateId: () => string;
	readonly isAccepting: () => boolean;
	readonly settleOutcome: (record: SecureFileMonitorRecord, outcome: SecureFileMonitorWorkerEvent) => void;
}

export async function registerSecureFileMonitor(
	context: SecureFileMonitorContext,
	options: RegisterFileMonitorOptions,
): Promise<string> {
	const displayPath = options.displayPath ?? options.path;
	const logicalParent = options.logicalParent ?? dirname(displayPath);
	const parentIdentity = assertDirectoryBinding(logicalParent, dirname(options.path), options.parentIdentity);
	const id = context.allocateId();
	let committed = false;
	let statePublicationAttempted = false;
	let bufferedOutcome: SecureFileMonitorWorkerEvent | undefined;
	let record: SecureFileMonitorRecord | undefined;
	try {
		const registration = await context.workers.register({
			directory: parentIdentity.canonicalPath,
			expectedDevice: parentIdentity.device,
			expectedInode: parentIdentity.inode,
			targetName: basename(options.path),
			event: options.event,
			timeoutMs: options.timeoutMs,
			onEvent: (outcome) => {
				if (!committed || !record) bufferedOutcome = outcome;
				else context.settleOutcome(record, outcome);
			},
		});
		record = {
			backend: "secure",
			id,
			description: options.description,
			path: options.path,
			displayPath,
			logicalParent,
			event: options.event,
			parentIdentity,
			registration,
			paused: false,
			settled: false,
			startedAtMs: Date.now(),
		};
		if (!context.isAccepting()) throw new Error("File monitor registry is shutting down.");
		options.onBeforeWatch?.(id);
		context.records.set(id, record);
		statePublicationAttempted = true;
		context.options.onChange();
		committed = true;
		if (bufferedOutcome) context.settleOutcome(record, bufferedOutcome);
		return id;
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		const rollbackErrors: Error[] = [];
		context.records.delete(id);
		if (record) {
			try {
				await record.registration.stop();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
			}
		}
		if (statePublicationAttempted) {
			try {
				context.options.onChange();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
			}
		}
		if (failure.message === "target already exists") {
			throw new FileMonitorRegistrationError(
				`Cannot watch for creation because the file already exists: ${displayPath}`,
			);
		}
		if (failure.message === "target does not exist") {
			throw new FileMonitorRegistrationError(
				`Cannot watch for modification because the file does not exist: ${displayPath}`,
			);
		}
		if (failure.message === "target is not a regular file") {
			throw new FileMonitorRegistrationError(`Cannot watch a non-regular file for modification: ${displayPath}`);
		}
		const cause = rollbackErrors.length > 0 ? new AggregateError([failure, ...rollbackErrors]) : failure;
		throw new FileMonitorRegistrationError(`Unable to register file monitor: ${displayPath}`, { cause });
	}
}
