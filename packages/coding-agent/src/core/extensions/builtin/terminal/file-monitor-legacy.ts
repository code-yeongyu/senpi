import { dirname } from "node:path";
import { runAllCleanup, runFileMonitorAsyncBoundary } from "./file-monitor-cleanup.ts";
import {
	assertDirectoryBinding,
	disposeFileMonitor,
	type FileMonitorPoll,
	FileMonitorRegistrationError,
	type FileMonitorWatch,
	type FileMonitorWatcher,
	inspectFileForRegistration,
	nativeFileMonitorPoll,
	nativeFileMonitorWatch,
	reconcileFileMonitorTarget,
} from "./file-monitor-runtime.ts";
import type {
	FileMonitorRecord,
	FileMonitorRegistryOptions,
	LegacyFileMonitorRecord,
	RegisterFileMonitorOptions,
} from "./file-monitor-types.ts";

const FILE_MONITOR_RECHECK_INTERVAL_MS = 1000;

export interface LegacyFileMonitorContext {
	readonly records: Map<string, FileMonitorRecord>;
	readonly options: FileMonitorRegistryOptions;
	readonly watch: FileMonitorWatch;
	readonly poll: FileMonitorPoll | undefined;
	readonly queueReconcile: (callback: () => void) => void;
	readonly allocateId: () => string;
}

export function createLegacyFileMonitorContext(
	records: Map<string, FileMonitorRecord>,
	options: FileMonitorRegistryOptions,
	allocateId: () => string,
): LegacyFileMonitorContext {
	return {
		records,
		options,
		allocateId,
		watch: options.watch ?? nativeFileMonitorWatch,
		poll: options.poll ?? (options.watch === undefined ? nativeFileMonitorPoll : undefined),
		queueReconcile: options.queueReconcile ?? queueMicrotask,
	};
}

export function registerLegacyFileMonitor(
	context: LegacyFileMonitorContext,
	options: RegisterFileMonitorOptions,
): string {
	const displayPath = options.displayPath ?? options.path;
	const logicalParent = options.logicalParent ?? dirname(displayPath);
	const parentIdentity = assertDirectoryBinding(logicalParent, dirname(options.path), options.parentIdentity);
	const baseline = inspectFileForRegistration(options.path);
	if (options.event === "create" && baseline) {
		throw new FileMonitorRegistrationError(
			`Cannot watch for creation because the file already exists: ${displayPath}`,
		);
	}
	if (options.event === "modify" && !baseline) {
		throw new FileMonitorRegistrationError(
			`Cannot watch for modification because the file does not exist: ${displayPath}`,
		);
	}
	if (options.event === "modify" && baseline?.kind !== "file") {
		throw new FileMonitorRegistrationError(`Cannot watch a non-regular file for modification: ${displayPath}`);
	}

	const id = context.allocateId();
	let committed = false;
	let record: LegacyFileMonitorRecord | undefined;
	let watcher: FileMonitorWatcher;
	try {
		watcher = context.watch(dirname(options.path), { encoding: "utf8", persistent: false }, () => {
			if (committed && record) scheduleReconcile(context, record);
		});
	} catch (error) {
		throw new FileMonitorRegistrationError(`Unable to watch file: ${options.path}`, { cause: error });
	}

	record = {
		backend: "legacy",
		id,
		description: options.description,
		path: options.path,
		displayPath,
		logicalParent,
		event: options.event,
		parentIdentity,
		baseline,
		watcher,
		reconcileQueued: false,
		stopPolling: undefined,
		timer: undefined,
		paused: false,
		settled: false,
		startedAtMs: Date.now(),
	};
	const activeRecord = record;
	let startupError: Error | undefined;
	let statePublicationAttempted = false;
	try {
		watcher.on("error", (error) => {
			if (committed) {
				runFileMonitorAsyncBoundary(
					() => settleLegacyFileMonitor(context, activeRecord, `watcher error: ${error.message}`),
					context.options.onError,
				);
			} else startupError ??= error;
		});
		if (startupError) throw startupError;
		options.onBeforeWatch?.(id);
		activeRecord.stopPolling = context.poll?.(
			activeRecord.path,
			{ interval: FILE_MONITOR_RECHECK_INTERVAL_MS, persistent: false },
			() => {
				if (committed) {
					runFileMonitorAsyncBoundary(() => reconcileTarget(context, activeRecord), context.options.onError);
				}
			},
		);
		activeRecord.timer = setTimeout(() => {
			runFileMonitorAsyncBoundary(() => {
				reconcileTarget(context, activeRecord);
				if (!activeRecord.settled) settleLegacyFileMonitor(context, activeRecord, "watcher timed_out");
			}, context.options.onError);
		}, options.timeoutMs);
		activeRecord.timer.unref();
		context.records.set(id, activeRecord);
		statePublicationAttempted = true;
		context.options.onChange();
		if (startupError) throw startupError;
		committed = true;
		reconcileTarget(context, activeRecord);
		return id;
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		const rollbackErrors: Error[] = [];
		context.records.delete(id);
		try {
			disposeFileMonitor(activeRecord);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
		}
		if (statePublicationAttempted) {
			try {
				context.options.onChange();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
			}
		}
		const cause = rollbackErrors.length > 0 ? new AggregateError([failure, ...rollbackErrors]) : failure;
		throw new FileMonitorRegistrationError(`Unable to register file monitor: ${displayPath}`, { cause });
	}
}

function reconcileTarget(context: LegacyFileMonitorContext, record: LegacyFileMonitorRecord): void {
	reconcileFileMonitorTarget(record, (summary, line) => settleLegacyFileMonitor(context, record, summary, line));
}

function scheduleReconcile(context: LegacyFileMonitorContext, record: LegacyFileMonitorRecord): void {
	if (record.settled || record.reconcileQueued) return;
	record.reconcileQueued = true;
	context.queueReconcile(() => {
		record.reconcileQueued = false;
		if (!record.settled) {
			runFileMonitorAsyncBoundary(() => reconcileTarget(context, record), context.options.onError);
		}
	});
}

export function settleLegacyFileMonitor(
	context: LegacyFileMonitorContext,
	record: LegacyFileMonitorRecord,
	summary: string,
	line?: string,
	notifyChange = true,
): void {
	if (record.settled) return;
	record.settled = true;
	const actions: Array<() => void> = [() => context.records.delete(record.id)];
	if (notifyChange) actions.push(() => context.options.onChange());
	actions.push(() => disposeFileMonitor(record));
	if (line !== undefined && !record.paused) {
		actions.push(() => context.options.emitLine(record.id, record.description, line));
	}
	actions.push(() =>
		context.options.emitSummary(record.id, record.description, line === undefined ? summary : `${summary}: ${line}`),
	);
	runAllCleanup(actions);
}
