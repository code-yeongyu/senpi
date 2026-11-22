import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionToolContext } from "@code-yeongyu/senpi";
import type { TimeoutPauseHandle } from "../timeouts/idle-timeout.ts";
import type { CellWrittenFilesOutcome } from "./report.ts";
import { type FsAccess, type RunGit, type ScanFs, workspaceFs } from "./scan-boundaries.ts";
import { WrittenFilesTracker } from "./tracker.ts";
import { WorkspaceScanner } from "./workspace-scan.ts";
import { reportWrittenFiles } from "./write-hooks.ts";

export interface CellWrittenFiles {
	readonly ready: Promise<void>;
	/** Never rejects: a failure here is reported in the outcome, it does not fail the cell. */
	settle(signal: AbortSignal): Promise<CellWrittenFilesOutcome | undefined>;
	close(): void;
}

/**
 * Settles a cell's written files with its budgets paused: the scan and the hooks are host work like a bridge call, so
 * they charge neither the cell's run budget nor its idle watchdog.
 */
export async function settleWrittenFiles(
	written: CellWrittenFiles | undefined,
	signal: AbortSignal,
	budgets: readonly TimeoutPauseHandle[],
): Promise<CellWrittenFilesOutcome | undefined> {
	if (written === undefined) return undefined;
	for (const budget of budgets) budget.pause();
	try {
		return await written.settle(signal);
	} finally {
		for (const budget of budgets) budget.resume();
	}
}

export interface WrittenFilesOptions {
	readonly cwd: string;
	readonly artifactsDir: string;
	readonly git: RunGit;
	/** Confined to `cwd` here, so nothing the check stats or reads lies outside the workspace. */
	readonly fs: FsAccess;
	readonly timeoutMs?: number;
	readonly pathLimit?: number;
	/**
	 * False on a hand whose loop runs elsewhere: an extension that also hooks the loop runs whole on the loop's side, and
	 * a result reported from here would reach this side's copy of it instead.
	 */
	readonly hooksRunHere?: () => boolean;
}

/** The tools whose completed call means its file went through the write hooks. */
export function isHookedWriteTool(toolName: string): boolean {
	return toolName === "write" || toolName === "edit";
}

/**
 * Per session: what eval cells wrote in the workspace without a `write` or `edit` call, sent through the hooks such a
 * call triggers and listed in the cell result (senpi#7232).
 */
export class WrittenFiles {
	readonly #cwd: string;
	readonly #fs: ScanFs;
	readonly #hooksRunHere: () => boolean;
	readonly #tracker: WrittenFilesTracker;

	constructor(options: WrittenFilesOptions) {
		this.#cwd = options.cwd;
		const fs = workspaceFs(options.cwd, options.fs);
		this.#fs = fs;
		this.#hooksRunHere = options.hooksRunHere ?? (() => true);
		const scanner = new WorkspaceScanner({
			cwd: options.cwd,
			artifactsDir: options.artifactsDir,
			git: options.git,
			fs,
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.pathLimit === undefined ? {} : { pathLimit: options.pathLimit }),
		});
		this.#tracker = new WrittenFilesTracker({
			cwd: options.cwd,
			scan: (previous) => scanner.scan(previous),
			stat: (path) => fs.stat(path),
		});
	}

	open(ctx: ExtensionToolContext): CellWrittenFiles {
		const window = this.#tracker.open();
		// A host older than this capability lists the files and says it cannot run the hooks.
		const report =
			this.#hooksRunHere() && typeof ctx.reportToolResult === "function"
				? (reported: Parameters<ExtensionToolContext["reportToolResult"]>[0]) => ctx.reportToolResult(reported)
				: undefined;
		return {
			ready: window.ready,
			settle: async (signal) => {
				try {
					const change = await window.settle();
					if (change.kind === "off") return undefined;
					if (change.kind === "unchecked") return change;
					const written = await reportWrittenFiles(change.files, {
						fs: this.#fs,
						report,
						noteHooked: (path) => this.#tracker.noteHooked(path),
						signal,
					});
					if (written === undefined) return undefined;
					return { kind: "written", report: written, hooksAvailable: report !== undefined };
				} catch (error) {
					return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
				}
			},
			close: () => window.close(),
		};
	}

	/**
	 * A tool call that completed through the hooks. A `write` or `edit` leaves its file accounted for, so the cell
	 * that made the call, or one that ran beside it, does not send that file through the hooks again.
	 */
	async noteToolCall(toolName: string, params: unknown): Promise<void> {
		if (!isHookedWriteTool(toolName) || typeof params !== "object" || params === null) return;
		const path = "path" in params ? params.path : undefined;
		if (typeof path === "string" && path !== "") await this.#tracker.noteHooked(toolPath(path, this.#cwd));
	}
}

/** The file a write or edit call named: the host's file tools drop a leading `@` and expand a leading `~`. */
function toolPath(named: string, cwd: string): string {
	const path = named.startsWith("@") ? named.slice(1) : named;
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(cwd, path);
}
