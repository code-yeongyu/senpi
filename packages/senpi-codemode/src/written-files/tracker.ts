import { isAbsolute, join, relative, sep } from "node:path";
import type { FileSignature, ScanFs } from "./scan-boundaries.ts";
import type { PreviousScan, ScanSkipReason, WorkspaceScan } from "./workspace-scan.ts";

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
	/** After the cell's code finished: the files that changed since the last report. */
	settle(): Promise<WrittenFilesChange>;
	/** Ends the window; safe to call more than once. */
	close(): void;
}

export interface WrittenFilesTrackerOptions {
	readonly cwd: string;
	readonly scan: (previous?: PreviousScan) => Promise<WorkspaceScan>;
	readonly stat: ScanFs["stat"];
}

/**
 * Scans in a row that fail or run over budget before the check turns itself off for the session. Three, not one: the
 * first scans of a session can meet a cold file cache, and a cell spends two (before it starts and when it settles).
 */
const SKIPS_BEFORE_OFF = 3;

function offWindow(): WrittenFilesWindow {
	return { ready: Promise.resolve(), settle: async () => ({ kind: "off" }), close: () => {} };
}

/**
 * Finds the files eval cells wrote by comparing the workspace before and after them. One baseline is shared by every
 * cell that is live at the same time: it is recorded before the first of them starts and advanced at each settlement,
 * so a change is reported exactly once, by the first cell to settle after it. Cells that overlap cannot be told
 * apart; a cell that runs alone is charged only with what changed while it ran.
 */
export class WrittenFilesTracker {
	readonly #cwd: string;
	readonly #scan: WrittenFilesTrackerOptions["scan"];
	readonly #stat: ScanFs["stat"];
	readonly #hooked = new Map<string, FileSignature>();
	#queue: Promise<void> = Promise.resolve();
	#baseline: PreviousScan | undefined;
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
		let closed = false;
		return {
			ready,
			settle: () => this.#enqueue(() => this.#report()),
			close: () => {
				if (closed) return;
				closed = true;
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
		const inside = relative(this.#cwd, absolutePath);
		if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return;
		const signature = await this.#stat(absolutePath);
		if (signature !== undefined && this.#live > 0) this.#hooked.set(inside.split(sep).join("/"), signature);
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
		this.#baseline = { files: new Map(scan.files), head: scan.head };
	}

	async #report(): Promise<WrittenFilesChange> {
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
		this.#baseline = { files: next, head: scan.head };
		files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		return { kind: "changed", files };
	}

	#skip(reason: ScanSkipReason): void {
		this.#skipped = reason;
		this.#skips += 1;
		if (reason === "git_unavailable" || this.#skips >= SKIPS_BEFORE_OFF) this.#disabled = true;
	}

	async #safeScan(previous: PreviousScan | undefined): Promise<WorkspaceScan> {
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
