import { lstatSync, realpathSync, unwatchFile, watch, watchFile } from "node:fs";
import { dirname } from "node:path";
import { runAllCleanup } from "./file-monitor-cleanup.ts";
import type { SecureFileMonitorWorkerPool } from "./secure-file-monitor-worker.ts";

export interface FileMonitorEntry {
	readonly ctimeMs: number;
	readonly device: number;
	readonly ino: number;
	readonly kind: "file" | "directory" | "symlink" | "other";
	readonly mtimeMs: number;
	readonly size: number;
}

export interface FileMonitorDirectoryIdentity {
	readonly device: bigint;
	readonly inode: bigint;
}

export interface FileMonitorDirectoryBinding extends FileMonitorDirectoryIdentity {
	readonly canonicalPath: string;
}

export class FileMonitorRegistrationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "FileMonitorRegistrationError";
	}
}

export interface FileMonitorWatcher {
	on(event: "error", listener: (error: Error) => void): this;
	close(): void;
}

export type FileMonitorWatch = (
	path: string,
	options: { readonly encoding: "utf8"; readonly persistent: false },
	listener: (eventType: string, filename: string | null) => void,
) => FileMonitorWatcher;

export type FileMonitorPoll = (
	path: string,
	options: { readonly interval: number; readonly persistent: false },
	listener: () => void,
) => () => void;

export interface FileMonitorRegistryDependencies {
	readonly poll?: FileMonitorPoll;
	readonly queueReconcile?: (callback: () => void) => void;
	readonly secureWorkers?: SecureFileMonitorWorkerPool;
	readonly watch?: FileMonitorWatch;
	readonly onError?: (error: Error) => void;
}

export function inspectFile(path: string): FileMonitorEntry | undefined {
	const stats = lstatSync(path, { throwIfNoEntry: false });
	if (!stats) return undefined;
	const kind = stats.isFile()
		? "file"
		: stats.isDirectory()
			? "directory"
			: stats.isSymbolicLink()
				? "symlink"
				: "other";
	return {
		ctimeMs: stats.ctimeMs,
		device: stats.dev,
		ino: stats.ino,
		kind,
		mtimeMs: stats.mtimeMs,
		size: stats.size,
	};
}

export function inspectDirectory(path: string): FileMonitorDirectoryIdentity | undefined {
	const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	if (!stats?.isDirectory()) return undefined;
	return { device: stats.dev, inode: stats.ino };
}

export function inspectDirectoryBinding(path: string): FileMonitorDirectoryBinding | undefined {
	const canonicalPath = realpathSync(path);
	const identity = inspectDirectory(canonicalPath);
	return identity ? { canonicalPath, ...identity } : undefined;
}

export function matchesDirectoryBinding(
	path: string,
	canonicalPath: string,
	identity: FileMonitorDirectoryIdentity,
): boolean {
	const current = inspectDirectoryBinding(path);
	return (
		current?.canonicalPath === canonicalPath && current.device === identity.device && current.inode === identity.inode
	);
}

export function assertDirectoryBinding(
	logicalPath: string,
	canonicalPath: string,
	expected: FileMonitorDirectoryIdentity | undefined,
): FileMonitorDirectoryBinding {
	try {
		const binding = inspectDirectoryBinding(logicalPath);
		if (
			!binding ||
			binding.canonicalPath !== canonicalPath ||
			(expected !== undefined && (binding.device !== expected.device || binding.inode !== expected.inode))
		) {
			throw new FileMonitorRegistrationError("The approved monitor parent changed before registration.");
		}
		return binding;
	} catch (error) {
		if (error instanceof FileMonitorRegistrationError) throw error;
		throw new FileMonitorRegistrationError(`Unable to inspect watch parent: ${canonicalPath}`, { cause: error });
	}
}

export interface DisposableFileMonitor {
	settled: boolean;
	stopPolling?: () => void;
	timer?: ReturnType<typeof setTimeout>;
	readonly watcher: FileMonitorWatcher;
}

export function disposeFileMonitor(record: DisposableFileMonitor): void {
	record.settled = true;
	const stopPolling = record.stopPolling;
	record.stopPolling = undefined;
	const timer = record.timer;
	record.timer = undefined;
	runAllCleanup([
		() => {
			if (timer !== undefined) clearTimeout(timer);
		},
		() => {
			stopPolling?.();
		},
		() => record.watcher.close(),
	]);
}

export function inspectFileForRegistration(path: string): FileMonitorEntry | undefined {
	try {
		return inspectFile(path);
	} catch (error) {
		throw new FileMonitorRegistrationError(`Unable to inspect file: ${path}`, { cause: error });
	}
}

export function sameFileEntry(left: FileMonitorEntry, right: FileMonitorEntry): boolean {
	return (
		left.ctimeMs === right.ctimeMs &&
		left.device === right.device &&
		left.ino === right.ino &&
		left.kind === right.kind &&
		left.mtimeMs === right.mtimeMs &&
		left.size === right.size
	);
}

export interface FileMonitorReconcileRecord {
	readonly path: string;
	readonly displayPath: string;
	readonly logicalParent: string;
	readonly event: "create" | "modify";
	readonly parentIdentity: FileMonitorDirectoryIdentity;
	readonly baseline: FileMonitorEntry | undefined;
	readonly settled: boolean;
}

export function reconcileFileMonitorTarget(
	record: FileMonitorReconcileRecord,
	settle: (summary: string, line?: string) => void,
): void {
	if (record.settled) return;
	try {
		if (!matchesDirectoryBinding(record.logicalParent, dirname(record.path), record.parentIdentity)) {
			settle("watcher error: approved monitor parent changed");
			return;
		}
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		settle(`watcher error: approved monitor parent changed: ${error.message}`);
		return;
	}
	let current: FileMonitorEntry | undefined;
	try {
		current = inspectFile(record.path);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		settle(`watcher error: ${error.message}`);
		return;
	}
	if (!current) return;
	if (current.kind !== "file") {
		settle(`watcher error: target is not a regular file: ${record.displayPath}`);
		return;
	}
	if (record.event === "modify" && record.baseline && sameFileEntry(record.baseline, current)) return;
	const verb = record.event === "create" ? "created" : "modified";
	settle("watcher completed", `${verb} ${record.displayPath}`);
}

export const nativeFileMonitorWatch: FileMonitorWatch = (path, options, listener) =>
	watch(path, options, (eventType, filename) => listener(eventType, filename));

export const nativeFileMonitorPoll: FileMonitorPoll = (path, options, listener) => {
	const pollListener = () => listener();
	watchFile(path, options, pollListener);
	return () => unwatchFile(path, pollListener);
};
