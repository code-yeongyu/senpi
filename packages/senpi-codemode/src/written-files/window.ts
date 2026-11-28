import type { ScanSkipReason } from "./workspace-scan.ts";

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

/** The selection without the listed files a model call took from the cell: it neither lists nor counts them. */
export function withoutCeded(selection: WrittenFilesSelection, ceded: readonly ChangedFile[]): WrittenFilesSelection {
	if (ceded.length === 0) return selection;
	const listed = selection.listed.filter((file) => !ceded.includes(file));
	return { listed, total: selection.total - ceded.length, hooks: selection.hooks };
}

export type WrittenFilesChange =
	| { readonly kind: "changed"; readonly selection: WrittenFilesSelection }
	/** The cell's writes could not be compared; `disabled` says the check is now off for the session. */
	| { readonly kind: "unchecked"; readonly reason: ScanSkipReason; readonly disabled: boolean }
	| { readonly kind: "off" };

/**
 * What `start` decided for a file: `started`, the hooks run now; `refused`, the cell no longer owns the file or has
 * closed, so it must not start them; `ceded`, a model `write` or `edit` call holds the file, so the cell let go of it,
 * the change is the call's, and the cell neither hooks nor lists nor counts it.
 */
export type HookStart = "started" | "refused" | "ceded";

/**
 * How a cell let go of a file it owned without hooking it: `ceded` when a model `write` or `edit` call took the file,
 * so the change is the call's and the cell neither reports nor counts it; `released` otherwise.
 */
export type ClaimRelease = "released" | "ceded";

/** A cell's view of the written-files check, from before its code starts until its write hooks are done. */
export interface WrittenFilesWindow {
	/** Resolves once the cell's code may start: the state its writes are compared with is recorded. */
	readonly ready: Promise<void>;
	/**
	 * After the cell's code finished: the files that changed since the last report, sorted, go through `select` inside
	 * the settling scan, and the cell owns the listed files it will hook until it lets go of them. The returned
	 * selection leaves out a file a model call took meanwhile.
	 */
	settle(select: (changed: readonly ChangedFile[]) => Promise<WrittenFilesSelection>): Promise<WrittenFilesChange>;
	/**
	 * Whether the cell starts the write hooks for a file now: only `started` lets it. From there the claim lasts until
	 * `hooked`, even past `close`.
	 */
	start(absolutePath: string): HookStart;
	/** The write hooks this cell ran for a file it reported returned: the state they left is this cell's, and it lets go. */
	hooked(absolutePath: string): Promise<void>;
	/**
	 * This cell will not run the write hooks for a file it owns (cancelled, or `start` refused): it lets go of it now, and
	 * the file's change stays for the next settlement to report.
	 */
	skipped(absolutePath: string): ClaimRelease;
	/** This cell reports that it could not read a file it owns back for the hooks: it lets go, and the change is reported. */
	failed(absolutePath: string): ClaimRelease;
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

/** The window of a session whose check has turned itself off. */
export function offWindow(): WrittenFilesWindow {
	return {
		ready: Promise.resolve(),
		settle: async () => ({ kind: "off" }),
		start: () => "refused",
		hooked: async () => {},
		skipped: () => "released",
		failed: () => "released",
		release: () => {},
		close: () => {},
	};
}
