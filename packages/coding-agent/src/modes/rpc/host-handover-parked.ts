/**
 * The handoff-parked residency record: the set of sessions a predecessor host held resident and
 * parked with `handoff_parked` (or its idle sweep), persisted so the SUCCESSOR can reopen them by
 * path with the same durable session id (senpi#3282).
 *
 * A `retain_on_disconnect` session must survive EVERY generation. Each parked session is ONE file
 * (`<daemonDir>/handover-parked/<sha>.json`) written atomically, so a successor removes exactly the
 * entry it reopened and nothing else - a predecessor that parks another session concurrently cannot
 * be clobbered by that removal, across processes. This per-entry shape is the cross-process guard:
 * there is no shared list file to read-merge-write, so there is no lost update to lock against.
 * The predecessor appends an entry (awaited, in-process mutex so two parks in one host keep both);
 * the successor reopens each entry with the same durable id and `retain_on_disconnect` and deletes
 * ONLY that entry's file after success (crash-safe, at most once, never lost). An entry whose
 * session file is gone is dropped, never retried.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRetryFallbackProfile } from "../../core/agent-session-runtime.ts";
import type { BrowserEngine } from "../../core/browser-engine.ts";
import type { PromptSurface } from "../../core/dynamic-prompt/types.ts";
import { parsePermissionPresetName } from "../../core/extensions/builtin/permission-system/cli.ts";
import type { SessionContext, SessionKind } from "../../core/extensions/types.ts";
import {
	sessionAutoTitleError,
	sessionBrowserEngineError,
	sessionContextError,
	sessionKindError,
	sessionPromptSurfaceError,
	sessionRetryFallbackError,
} from "./rpc-input-validation.ts";
import { syncDirectory, writeFileDurably } from "./host-state-json.ts";
import { applyContextPatch, type SessionContextOverlay } from "./session-context-patch.ts";

export interface HandoverParkedEntry {
	readonly sessionPath: string;
	readonly durableSessionId?: string;
	readonly retainOnDisconnect: boolean;
	readonly cwd?: string;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
	/**
	 * The session's launch-profile choices a client-less reopen has no other source for: without them
	 * the successor opens the session under the host defaults, and an `ask` session runs gated tools
	 * without asking (senpi#3364).
	 */
	readonly permissionPreset?: string;
	readonly promptSurface?: PromptSurface;
	readonly browserEngine?: BrowserEngine;
	/**
	 * The rest of the client's `open_session` choices, so the successor reopens the session through
	 * the same open as any client would (senpi#3368): its visibility class (a worker stays invisible by
	 * default, I4), the CLIENT part of its context (the host-owned keys are the successor's own and
	 * are re-merged on open), its auto-titling and its retry fallback.
	 */
	readonly sessionKind?: SessionKind;
	readonly sessionContext?: SessionContext;
	readonly contextOverlay?: SessionContextOverlay;
	readonly autoTitle?: boolean;
	readonly retryFallback?: SessionRetryFallbackProfile;
	/**
	 * The host instance that wrote the park. Its own reopen watch skips it: the park is for the NEXT
	 * generation, and a host reopening what it just idle-parked races the client's reopen (senpi#3485).
	 * Absent on entries an older generation wrote, which every reader treats as a predecessor's park.
	 */
	readonly parkedBy?: string;
	/**
	 * The transfer this park is (code-yeongyu/oh-my-openagent#10091): a later park of the same path is another
	 * transfer, and the cleanup of an earlier one removes only its own. Absent on entries older generations wrote.
	 */
	readonly transferId?: string;
	/**
	 * The successor's last failed reopen of this transfer (code-yeongyu/oh-my-openagent#10091). The record stays: the
	 * reopen is tried again when a claim or a generation changes, and a client may open the path itself meanwhile.
	 */
	readonly failedTransfer?: HandoverParkedFailure;
}

export interface HandoverParkedFailure {
	readonly reason: string;
	readonly at: string;
	readonly attempts: number;
}

/** One file per parked session; the successor's reopen watches this directory. */
export function handoverParkedRecordDir(daemonDir: string): string {
	return join(daemonDir, "handover-parked");
}

const entryFile = (daemonDir: string, sessionPath: string): string =>
	join(
		handoverParkedRecordDir(daemonDir),
		`${createHash("sha256").update(sessionPath, "utf8").digest("hex").slice(0, 16)}.json`,
	);

let mutationChain: Promise<void> = Promise.resolve();

function enqueueMutation(mutation: () => Promise<void>): Promise<void> {
	const next = mutationChain.then(mutation, mutation);
	mutationChain = next.catch(() => {});
	return next;
}

function isEntry(value: unknown): value is HandoverParkedEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.sessionPath === "string" &&
		typeof record.retainOnDisconnect === "boolean" &&
		(record.durableSessionId === undefined || typeof record.durableSessionId === "string") &&
		(record.cwd === undefined || typeof record.cwd === "string") &&
		(record.parkedBy === undefined || typeof record.parkedBy === "string") &&
		(record.transferId === undefined || typeof record.transferId === "string") &&
		(record.failedTransfer === undefined || isFailure(record.failedTransfer)) &&
		(record.thinkingLevel === undefined || typeof record.thinkingLevel === "string") &&
		(record.permissionPreset === undefined ||
			(typeof record.permissionPreset === "string" &&
				parsePermissionPresetName(record.permissionPreset) !== undefined)) &&
		sessionPromptSurfaceError(record.promptSurface) === undefined &&
		sessionBrowserEngineError(record.browserEngine) === undefined &&
		sessionKindError(record.sessionKind) === undefined &&
		sessionContextError(record.sessionContext) === undefined &&
		(record.contextOverlay === undefined || !("refusal" in applyContextPatch(undefined, record.contextOverlay))) &&
		sessionAutoTitleError(record.autoTitle) === undefined &&
		sessionRetryFallbackError(record.retryFallback) === undefined &&
		(record.model === undefined ||
			(typeof record.model === "object" &&
				record.model !== null &&
				typeof (record.model as Record<string, unknown>).provider === "string" &&
				typeof (record.model as Record<string, unknown>).modelId === "string"))
	);
}

function isFailure(value: unknown): value is HandoverParkedFailure {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const attempts: unknown = Reflect.get(value, "attempts");
	return (
		typeof Reflect.get(value, "reason") === "string" &&
		typeof Reflect.get(value, "at") === "string" &&
		typeof attempts === "number" &&
		Number.isSafeInteger(attempts) &&
		attempts > 0
	);
}

async function writeEntryFile(daemonDir: string, entry: HandoverParkedEntry): Promise<void> {
	await mkdir(handoverParkedRecordDir(daemonDir), { recursive: true, mode: 0o700 });
	await writeFileDurably(entryFile(daemonDir, entry.sessionPath), `${JSON.stringify(entry, null, 2)}\n`);
}

/** Resolves once the entry is on disk to stay: a park whose record cannot be written must not tear its session down. */
export function recordHandoverParkedSession(daemonDir: string, entry: HandoverParkedEntry): Promise<void> {
	return enqueueMutation(() => writeEntryFile(daemonDir, entry));
}

export async function readHandoverParkedSessions(daemonDir: string): Promise<readonly HandoverParkedEntry[]> {
	let names: string[];
	try {
		names = (await readdir(handoverParkedRecordDir(daemonDir))).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const entries: HandoverParkedEntry[] = [];
	for (const name of names) {
		const file = join(handoverParkedRecordDir(daemonDir), name);
		try {
			const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
			if (isEntry(parsed)) entries.push(parsed);
			// A well-formed JSON value that fails the shape check is not corrupt: it may be an entry a
			// different-version generation wrote (a rollback handover). Leave it alone.
		} catch (cause) {
			// Writes are atomic (renameSync), so a torn write cannot happen; only a genuinely corrupt
			// payload (SyntaxError) is dropped. ENOENT is a normal race with a concurrent clear, and
			// EMFILE/EACCES are transient - dropping an entry for any of those loses a retained session
			// for good. On any of those, skip the entry and leave the file for the next read.
			if (cause instanceof SyntaxError) {
				process.stderr.write(`senpi rpc handover-parked entry ${name} is corrupt; dropping it\n`);
				await rm(file, { force: true });
			}
		}
	}
	return entries;
}

/**
 * Removes the record of `sessionPath`; with `transferId`, only while it is still that transfer's. Reading and
 * then removing is safe here: a path's record is written only by the generation that owns the session, and
 * this process orders its own writes and removals on one mutation chain.
 */
export function clearHandoverParkedSession(daemonDir: string, sessionPath: string, transferId?: string): Promise<void> {
	return enqueueMutation(async () => {
		const file = entryFile(daemonDir, sessionPath);
		if (transferId !== undefined && (await readEntry(file))?.transferId !== transferId) return;
		await rm(file, { force: true });
		await syncDirectory(handoverParkedRecordDir(daemonDir)).catch(() => undefined);
	});
}

/** Records why the successor could not reopen `entry`, only while the record still holds that transfer. */
export function recordHandoverParkedFailure(
	daemonDir: string,
	entry: HandoverParkedEntry,
	failure: HandoverParkedFailure,
): Promise<void> {
	return enqueueMutation(async () => {
		const current = await readEntry(entryFile(daemonDir, entry.sessionPath));
		if (current === undefined || current.transferId !== entry.transferId) return;
		await writeEntryFile(daemonDir, { ...current, failedTransfer: failure });
	});
}

async function readEntry(file: string): Promise<HandoverParkedEntry | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		return isEntry(parsed) ? parsed : undefined;
	} catch {
		// Absent or unreadable: nothing to compare against, so nothing changes.
		return undefined;
	}
}
