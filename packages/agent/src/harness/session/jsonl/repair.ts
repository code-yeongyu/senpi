import type { Context } from "../../context.ts";
import type { FileSystem } from "../../types.ts";
import { fileValue, publishFileAtomically } from "./io.ts";
import type { JsonlRecoveryCause, JsonlStorageOptions, JsonlStorageRecovery } from "./types.ts";

/** A repair that is computed but not yet on disk: the content to keep and the damaged bytes to set aside first. */
interface PendingRepair {
	readonly content: string;
	readonly setAside: string;
	readonly droppedRecords: number;
	readonly cause: JsonlRecoveryCause;
}

const DISK_FULL_CODES = new Set(["ENOSPC", "EDQUOT"]);

function recoveryCause(error: unknown): JsonlRecoveryCause {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		if ("code" in current && typeof current.code === "string" && DISK_FULL_CODES.has(current.code))
			return "disk_full";
		current = current.cause;
	}
	return "write_failed";
}

/**
 * Where the damage left by a failed append starts: the whole failed line when every byte landed anyway (the caller
 * was told it failed, so it is not kept), else the fragment after the last newline, else nothing.
 */
function failedAppendStart(content: string, failedLine: string): number | undefined {
	if (content.endsWith(failedLine)) return content.length - failedLine.length;
	if (content.endsWith("\n")) return undefined;
	return content.lastIndexOf("\n") + 1;
}

function recoveryMessage(cause: JsonlRecoveryCause, droppedRecords: number, backupPath: string): string {
	if (cause === "disk_full") {
		return `The last message wasn't saved because the disk was full. Free disk space to keep saving this session; the incomplete record was set aside in ${backupPath}.`;
	}
	if (cause === "write_failed") {
		return `The last message wasn't saved because writing the session failed. The incomplete record was set aside in ${backupPath}.`;
	}
	const what = droppedRecords === 1 ? "1 incomplete record" : `${droppedRecords} damaged records`;
	return `This session had ${what} from an interrupted save (for example a full disk). Every other record was loaded; the damaged bytes were set aside in ${backupPath}.`;
}

async function freeBackupPath(fileSystem: FileSystem, path: string, stamp: number, context: Context): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		const candidate = attempt === 0 ? `${path}.torn-${stamp}` : `${path}.torn-${stamp}-${attempt}`;
		if (!fileValue(await fileSystem.exists(candidate, context), `Failed to inspect ${candidate}`)) return candidate;
	}
}

/**
 * Keeps a JSONL session file free of damage before every append. Damaged bytes (a torn append, records found
 * unreadable on open) are copied to `<file>.torn-<time>` atomically and never deleted, then the file is rewritten
 * atomically with what remains, and `onRecovery` is told once.
 */
export class JsonlRepairs {
	private readonly options: JsonlStorageOptions;
	private failedAppend: { readonly line: string; readonly cause: JsonlRecoveryCause } | undefined;
	private pending: PendingRepair | undefined;

	constructor(options: JsonlStorageOptions) {
		this.options = options;
	}

	/** Records an append that failed; any of its bytes that landed are cut before the next append. */
	appendFailed(line: string, error: unknown): void {
		this.failedAppend = { line, cause: recoveryCause(error) };
	}

	/**
	 * Sets aside the damage `open` found. A refusal (a full disk can refuse the copy) is deferred, not dropped: the
	 * file stays untouched and the next append retries the repair first and fails with its error.
	 */
	async repairOnOpen(kept: string, setAside: readonly string[], context: Context): Promise<void> {
		if (setAside.length === 0) return;
		this.pending = { content: kept, setAside: setAside.join(""), droppedRecords: setAside.length, cause: "unknown" };
		try {
			await this.applyPending(context);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
		}
	}

	async beforeAppend(context: Context): Promise<void> {
		const { fileSystem, path } = this.options;
		if (this.failedAppend !== undefined) {
			const { line, cause } = this.failedAppend;
			const content = fileValue(
				await fileSystem.readTextFile(path, context),
				`Failed to read JSONL storage ${path}`,
			);
			this.failedAppend = undefined;
			const start = failedAppendStart(content, line);
			if (start !== undefined) {
				this.pending = {
					content: content.slice(0, start),
					setAside: content.slice(start),
					droppedRecords: 1,
					cause,
				};
			}
		}
		await this.applyPending(context);
	}

	private async applyPending(context: Context): Promise<void> {
		const repair = this.pending;
		if (repair === undefined) return;
		const { fileSystem, path } = this.options;
		const backupPath = await freeBackupPath(fileSystem, path, (this.options.now ?? Date.now)(), context);
		await publishFileAtomically(fileSystem, backupPath, context, (append) => append(repair.setAside));
		await publishFileAtomically(fileSystem, path, context, (append) => append(repair.content));
		this.pending = undefined;
		const recovery: JsonlStorageRecovery = {
			path,
			backupPath,
			droppedRecords: repair.droppedRecords,
			cause: repair.cause,
			message: recoveryMessage(repair.cause, repair.droppedRecords, backupPath),
		};
		this.options.onRecovery?.(recovery);
	}
}
