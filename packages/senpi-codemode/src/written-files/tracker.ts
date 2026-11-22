import { isAbsolute, join, relative, sep } from "node:path";
import type { FileSignature } from "./scan-boundaries.ts";
import type { ScanFs } from "./workspace-fs.ts";
import type { ScanSkipReason, ScannedFiles, WorkspaceScan } from "./workspace-scan.ts";

export interface ChangedFile {
	/** Workspace-relative POSIX path. */
	readonly path: string;
	readonly absolutePath: string;
}

export type WrittenFilesChange =
	| { readonly kind: "changed"; readonly files: readonly ChangedFile[] }
	/** The cell's writes could not be compared; `disabled` says the check is now off for the session. */
	| { readonly kind: "unchecked"; readonly reason: ScanSkipReason; readonly disabled: boolean }
	| { readonly kind: "off" };

export interface WrittenFilesWindow {
	/** Resolves once the cell's code may start: the state its writes are compared with is recorded. */
	readonly ready: Promise<void>;
	/** After the cell's code finished: the files that changed since the last report, owned by this cell until released. */
	settle(): Promise<WrittenFilesChange>;
	/** The write hooks this cell ran for a file it reported returned: the state they left is this cell's, and it lets go. */
	hooked(absolutePath: string): Promise<void>;
	/** This cell's hooks are done: it lets go of every file it still owns. */
	release(): void;
	/** Ends the window and lets go of its files; safe to call more than once. */
	close(): void;
}

export interface WrittenFilesTrackerOptions {
	readonly cwd: string;
	readonly scan: (previous?: ScannedFiles) => Promise<WorkspaceScan>;
	readonly stat: ScanFs["stat"];
}

/**
 * Scans in a row that fail or run over budget before the check turns itself off for the session. Three, not one: the
 * first scans of a session can meet a cold file cache, and a cell spends two (before it starts and when it settles).
 */
const SKIPS_BEFORE_OFF = 3;

function offWindow(): WrittenFilesWindow {
	return {
		ready: Promise.resolve(),
		settle: async () => ({ kind: "off" }),
		hooked: async () => {},
		release: () => {},
		close: () => {},
	};
}

/**
 * Finds the files eval cells wrote by comparing the workspace before and after them. One baseline is shared by every
 * cell that is live at the same time: it is recorded before the first of them starts and advanced at each settlement,
 * so a change is reported exactly once, by the first cell to settle after it. Cells that overlap cannot be told
 * apart; a cell that runs alone is charged only with what changed while it ran.
 *
 * A settlement owns the files it reports until its write hooks for them return: a hook (a formatter) may rewrite a
 * file, and that rewrite is the reporting cell's. Ownership is taken inside the settling scan, so no later scan can
 * run between the report and the claim, and a scan that finds an owned file changed leaves it and its baseline alone;
 * once the hook returns, its result is recorded as hooked and the next scan compares with that. No lock is held over
 * the hooks: a hook may itself call `write` or run an eval cell, whose scans then queue behind nothing of this cell's.
 * Ownership ends when the hook call returns or fails, when the cell's hooks stop (abort, limit) or when it closes; the
 * host bounds each `tool_result` handler, so a stuck hook holds only its own file and only until that deadline.
 */
export class WrittenFilesTracker {
	readonly #cwd: string;
	readonly #scan: WrittenFilesTrackerOptions["scan"];
	readonly #stat: ScanFs["stat"];
	readonly #hooked = new Map<string, FileSignature>();
	/** Reported files whose settlement's hooks are still running, and the window that settled them. */
	readonly #owned = new Map<string, object>();
	#queue: Promise<void> = Promise.resolve();
	#baseline: ScannedFiles | undefined;
	#skipped: ScanSkipReason | undefined;
	#skips = 0;
	#live = 0;
	#disabled = false;

	constructor(options: WrittenFilesTrackerOptions) {
		this.#cwd = options.cwd;
		this.#scan = options.scan;
		this.#stat = options.stat;
	}

	open(): WrittenFilesWindow {
		if (this.#disabled) return offWindow();
		this.#live += 1;
		// A later cell also waits for the scan in flight, so its first writes are not swept into that scan.
		const ready = this.#live === 1 ? this.#enqueue(() => this.#recordBaseline()) : this.#queue;
		const owner = {};
		const release = (path?: string) => {
			for (const [owned, by] of this.#owned)
				if (by === owner && (path === undefined || owned === path)) this.#owned.delete(owned);
		};
		let closed = false;
		return {
			ready,
			settle: () => this.#enqueue(() => this.#report(owner)),
			hooked: async (absolutePath) => {
				try {
					await this.noteHooked(absolutePath);
				} finally {
					const path = this.#workspacePath(absolutePath);
					if (path !== undefined) release(path);
				}
			},
			release: () => release(),
			close: () => {
				if (closed) return;
				closed = true;
				release();
				this.#live -= 1;
				if (this.#live > 0) return;
				this.#baseline = undefined;
				this.#skipped = undefined;
				this.#hooked.clear();
			},
		};
	}

	/** A write or edit call took this file through the hooks: its present state is not a cell's unhooked write. */
	async noteHooked(absolutePath: string): Promise<void> {
		if (this.#live === 0) return;
		const path = this.#workspacePath(absolutePath);
		if (path === undefined) return;
		const signature = await this.#stat(absolutePath);
		if (signature !== undefined && this.#live > 0) this.#hooked.set(path, signature);
	}

	/** The workspace-relative POSIX path of a file inside the workspace. */
	#workspacePath(absolutePath: string): string | undefined {
		const inside = relative(this.#cwd, absolutePath);
		return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? undefined : inside.split(sep).join("/");
	}

	async #recordBaseline(): Promise<void> {
		const scan = await this.#safeScan(undefined);
		if (this.#live === 0) return;
		if (scan.kind === "skipped") {
			this.#baseline = undefined;
			this.#skip(scan.reason);
			return;
		}
		this.#skips = 0;
		this.#skipped = undefined;
		this.#baseline = { files: new Map(scan.files), head: scan.head, tracked: scan.tracked };
	}

	async #report(owner: object): Promise<WrittenFilesChange> {
		const baseline = this.#baseline;
		if (baseline === undefined) {
			const reason = this.#skipped ?? "scan_failed";
			// The cells still running are compared from here on; a cell that ran alone spends no second scan.
			if (!this.#disabled && this.#live > 1) await this.#recordBaseline();
			return { kind: "unchecked", reason, disabled: this.#disabled };
		}
		const scan = await this.#safeScan(baseline);
		if (scan.kind === "skipped") {
			this.#baseline = undefined;
			this.#skip(scan.reason);
			return { kind: "unchecked", reason: scan.reason, disabled: this.#disabled };
		}
		this.#skips = 0;
		const next = new Map(scan.files);
		const files: ChangedFile[] = [];
		for (const [path, signature] of scan.files) {
			const before = baseline.files.get(path);
			if (before !== undefined && sameSignature(before, signature)) continue;
			if (this.#owned.has(path)) {
				// Another settlement's hooks are on it: what they leave is theirs, and the next scan compares with that.
				if (before === undefined) next.delete(path);
				else next.set(path, before);
				continue;
			}
			const absolutePath = join(this.#cwd, path);
			const hooked = this.#hooked.get(path);
			if (hooked !== undefined) {
				this.#hooked.delete(path);
				if (sameSignature(hooked, signature)) continue;
				// The scan may predate that call, so only a state the call did not leave counts as a change.
				const current = await this.#stat(absolutePath);
				if (current === undefined) {
					next.delete(path);
					continue;
				}
				next.set(path, current);
				if (sameSignature(hooked, current)) continue;
			}
			files.push({ path, absolutePath });
		}
		this.#baseline = { files: next, head: scan.head, tracked: scan.tracked };
		for (const file of files) this.#owned.set(file.path, owner);
		files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		return { kind: "changed", files };
	}

	#skip(reason: ScanSkipReason): void {
		this.#skipped = reason;
		this.#skips += 1;
		if (reason === "git_unavailable" || this.#skips >= SKIPS_BEFORE_OFF) this.#disabled = true;
	}

	async #safeScan(previous: ScannedFiles | undefined): Promise<WorkspaceScan> {
		try {
			return await this.#scan(previous);
		} catch {
			return { kind: "skipped", reason: "scan_failed" };
		}
	}

	/** Scans and baseline updates run one at a time, in the order they were asked for. */
	#enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
		const run = this.#queue.then(task);
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

function sameSignature(left: FileSignature, right: FileSignature): boolean {
	return (
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.ino === right.ino
	);
}
