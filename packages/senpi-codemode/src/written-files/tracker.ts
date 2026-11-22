import { join, relative, sep } from "node:path";
import { type FileSignature, sameSignature } from "./scan-boundaries.ts";
import { type Claim, FileOwnership, type Owner } from "./ownership.ts";
import { escapesWorkspace, type ScanFs } from "./workspace-fs.ts";
import type { ScanSkipReason, ScannedFiles, WorkspaceScan } from "./workspace-scan.ts";

export interface ChangedFile {
	/** Workspace-relative POSIX path. */
	readonly path: string;
	readonly absolutePath: string;
}

/** What a settling cell does with the files that changed: the one choice both its claim and its hooks follow. */
export interface WrittenFilesSelection {
	/** The changed files the cell lists, in path order; it sends them through the write hooks when `hooks` is set. */
	readonly listed: readonly ChangedFile[];
	/** How many changed files the cell counts as written, listed or not. */
	readonly total: number;
	readonly hooks: boolean;
}

export type WrittenFilesChange =
	| { readonly kind: "changed"; readonly selection: WrittenFilesSelection }
	/** The cell's writes could not be compared; `disabled` says the check is now off for the session. */
	| { readonly kind: "unchecked"; readonly reason: ScanSkipReason; readonly disabled: boolean }
	| { readonly kind: "off" };

export interface WrittenFilesWindow {
	/** Resolves once the cell's code may start: the state its writes are compared with is recorded. */
	readonly ready: Promise<void>;
	/**
	 * After the cell's code finished: the files that changed since the last report, sorted, go through `select` inside
	 * the settling scan, and the cell owns the listed files it will hook until it lets go of them.
	 */
	settle(select: (changed: readonly ChangedFile[]) => Promise<WrittenFilesSelection>): Promise<WrittenFilesChange>;
	/**
	 * The cell starts the write hooks for a file now: false when it no longer owns the file or has closed, and then it
	 * must not start them. From here the claim lasts until `hooked`, even past `close`.
	 */
	start(absolutePath: string): boolean;
	/** The write hooks this cell ran for a file it reported returned: the state they left is this cell's, and it lets go. */
	hooked(absolutePath: string): Promise<void>;
	/**
	 * This cell will not run the write hooks for a file it owns (cancelled, or `start` refused): it lets go of it now, and
	 * the file's change stays for the next settlement to report.
	 */
	skipped(absolutePath: string): void;
	/** This cell reports that it could not read a file it owns back for the hooks: it lets go, and the change is reported. */
	failed(absolutePath: string): void;
	/** This cell's hooks are done: it lets go of every file it still owns. */
	release(): void;
	/** Ends the window and lets go of the files whose hooks have not started; safe to call more than once. */
	close(): void;
}

/** A `write` or `edit` call's hold on its file, from before the call writes it until the call ends. */
export interface ToolCallHold {
	/** The call ended; `hooked` when it completed through the hooks, so the state it left is not a cell's write. */
	end(hooked: boolean): Promise<void>;
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
		start: () => false,
		hooked: async () => {},
		skipped: () => {},
		failed: () => {},
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
 * A settlement owns the files it will send through the write hooks until those hooks return: a hook (a formatter) may
 * rewrite a file, and that rewrite is the reporting cell's. A changed file it only counts (past the limit, not source)
 * or will not hook (no hooks on this host) stays unowned, so a later scan still reports a change made to it. Ownership
 * is taken inside the settling scan, so no later scan can run between the report and the claim, and a scan that finds
 * an owned file changed leaves it and its baseline alone. No lock is held over the hooks: a hook may itself call
 * `write` or run an eval cell, whose scans then queue behind nothing of this cell's.
 *
 * The baseline advances, file by file, only for a change that is reported: a settlement that claims a file and then
 * ends the claim without starting its hooks puts that file's baseline back, so the next settlement reports the change.
 *
 * A claim is pending until the cell starts that file's hooks (`start`, the one dispatch point) and started after.
 * - Settlement selects files with hooks on, cell open: claims exactly the listed files, pending.
 * - Cell closed before its selection returns: claims nothing, `start` refuses, so nothing is dispatched, and the
 *   listed files keep their baseline (no one reads that list).
 * - Hooks stop at the limit, or no hooks here: the files past it, or all, are never claimed.
 * - Cancelled before a file's dispatch, or `start` refused: `skipped` ends that pending claim now and puts the file's
 *   baseline back, unless a later settlement has reported a newer change to it meanwhile.
 * - The file is unreadable: `failed` ends the pending claim; the failure is reported, so the baseline stays advanced.
 * - `start` while open: the claim becomes started; `start` after close, or without a claim, refuses.
 * - Hook returns, throws, or the host's handler deadline ends it: `hooked` records the state left and ends the claim.
 * - Settlement done (`release`): ends every claim left, none started, and puts their baselines back.
 * - Cell closes (normally, cancelled before or during dispatch): ends its pending claims, putting their baselines
 *   back, and keeps a started one until its `hooked`, so a cancelled cell's running formatter owns its rewrite.
 * - A nested cell a hook starts: settles normally and skips the files the outer cell owns.
 * - A model `write` or `edit` call starts (`holdForCall`): its file is held from before the call writes it until the
 *   call ends, so a settlement in between skips it and keeps its baseline; the call's own hooks are the only ones.
 *   The call's end records the state it left and lets go; two calls on one file hold it until both end.
 * A claim lasts until the whole `tool_result` handler chain for its file returns, not until one handler's deadline:
 * the host moves on to the next handler when one times out. A write that lands after the claim ended (a handler that
 * outlived its deadline) is a change like any other, reported by whichever cell settles next.
 */
export class WrittenFilesTracker {
	readonly #cwd: string;
	readonly #scan: WrittenFilesTrackerOptions["scan"];
	readonly #stat: ScanFs["stat"];
	readonly #hooked = new Map<string, FileSignature>();
	readonly #ownership = new FileOwnership();
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
		const owner: Owner = { closed: false };
		const claimOf = (absolutePath: string) => {
			const path = this.#workspacePath(absolutePath);
			const claim = path === undefined ? undefined : this.#ownership.claimOf(path, owner);
			return claim === undefined || path === undefined ? undefined : { path, claim };
		};
		const release = (keepStarted: boolean) => {
			for (const [path, claim] of this.#ownership.claimsOf(owner))
				if (!(keepStarted && claim.started)) this.#endClaim(path, claim, false);
		};
		const releaseFile = (absolutePath: string, reported: boolean) => {
			const owned = claimOf(absolutePath);
			if (owned !== undefined) this.#endClaim(owned.path, owned.claim, reported);
		};
		return {
			ready,
			settle: (select) => this.#enqueue(() => this.#report(owner, select)),
			start: (absolutePath) => {
				const owned = claimOf(absolutePath);
				if (owned === undefined || owner.closed) return false;
				owned.claim.started = true;
				return true;
			},
			hooked: async (absolutePath) => {
				try {
					await this.noteHooked(absolutePath);
				} finally {
					releaseFile(absolutePath, true);
				}
			},
			skipped: (absolutePath) => releaseFile(absolutePath, false),
			failed: (absolutePath) => releaseFile(absolutePath, true),
			release: () => release(false),
			close: () => {
				if (owner.closed) return;
				owner.closed = true;
				// A hook already running keeps its file: what it leaves is still this cell's (`hooked` ends that claim).
				release(true);
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

	/**
	 * A model `write` or `edit` call is about to write this file and run its hooks: no settlement reports or hooks the
	 * file until `end`. A path outside the workspace is not held.
	 */
	holdForCall(absolutePath: string): ToolCallHold | undefined {
		const path = this.#workspacePath(absolutePath);
		if (path === undefined) return undefined;
		const letGo = this.#ownership.holdForCall(path);
		let held = true;
		return {
			end: async (hooked) => {
				if (!held) return;
				held = false;
				try {
					if (hooked) await this.noteHooked(absolutePath);
				} finally {
					letGo();
				}
			},
		};
	}

	/** Ends a claim; one that ends without its hooks started or its failure reported puts the file's baseline back. */
	#endClaim(path: string, claim: Claim, reported: boolean): void {
		this.#ownership.endClaim(path);
		if (reported || claim.started) return;
		// Queued, so it lands after any settlement already running, which compared this file with the advanced baseline,
		// and before the baseline a later first cell records (closing the last cell drops this one first).
		void this.#enqueue(async () => {
			const baseline = this.#baseline;
			const now = baseline?.files.get(path);
			// A later settlement that reported a newer change has moved the baseline on: that change is reported already.
			if (baseline === undefined || now === undefined || !sameSignature(now, claim.advanced)) return;
			const files = new Map(baseline.files);
			setEntry(files, path, claim.before);
			this.#baseline = { ...baseline, files };
		});
	}

	/** The workspace-relative POSIX path of a file inside the workspace. */
	#workspacePath(absolutePath: string): string | undefined {
		const inside = relative(this.#cwd, absolutePath);
		return inside === "" || escapesWorkspace(inside) ? undefined : inside.split(sep).join("/");
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

	async #report(
		owner: Owner,
		select: (changed: readonly ChangedFile[]) => Promise<WrittenFilesSelection>,
	): Promise<WrittenFilesChange> {
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
			if (this.#ownership.owned(path)) {
				// Another settlement's hooks, or a model write's, are on it: what they leave is theirs, compared with later.
				setEntry(next, path, before);
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
		files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		const selection = await select(files);
		// A cell that closed while the selection read its files lists them to no one and hooks nothing: it claims nothing,
		// and their changes stay for the next settlement.
		if (owner.closed) for (const file of selection.listed) setEntry(next, file.path, baseline.files.get(file.path));
		this.#baseline = { files: next, head: scan.head, tracked: scan.tracked };
		if (selection.hooks && !owner.closed)
			for (const file of selection.listed) {
				const advanced = next.get(file.path);
				const before = baseline.files.get(file.path);
				if (advanced !== undefined) this.#ownership.claim(file.path, { owner, started: false, before, advanced });
			}
		return { kind: "changed", selection };
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

function setEntry(files: Map<string, FileSignature>, path: string, signature: FileSignature | undefined): void {
	if (signature === undefined) files.delete(path);
	else files.set(path, signature);
}
