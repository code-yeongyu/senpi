/**
 * The trash core (omo#11072): move to trash, list, restore, empty, and the one explicit permanent delete.
 * Every permanent delete - `empty`, retention expiry, size-cap eviction, an explicit request - appends one
 * row per target to the audit log after the data is gone.
 */
import { homedir } from "node:os";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { appendDeleteAudit, type DeleteActor, type DeleteAuditRow } from "./audit.ts";
import { assertTrashable, measureBytes, trashCapBytes } from "./disk.ts";
import { newEntryId, pathExists, readEntries, removeEntry, type TrashEntry, writeEntry } from "./entries.ts";
import { freedesktopTrashFor, homeTrashDir, moveToFreedesktopTrash, type RenameFn } from "./freedesktop.ts";
import { moveToMacTrash } from "./macos.ts";
import type { DeletePolicy } from "./policy.ts";
import { errnoCode, TrashError } from "./trash-error.ts";

const DAY_MS = 86_400_000;

export interface TrashScope {
	readonly agentDir: string;
	readonly policy: DeletePolicy;
	readonly sessionId: string | null;
	readonly actor: DeleteActor;
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly now?: () => number;
	/** Replaces `fs.rename` for moves into and out of the trash; lets a test reproduce `EXDEV` without a second mount. */
	readonly rename?: RenameFn;
}

export type EmptySelection =
	| { readonly kind: "policy" }
	| { readonly kind: "all" }
	| { readonly kind: "older-than"; readonly ms: number };

const envOf = (scope: TrashScope): NodeJS.ProcessEnv => scope.env ?? process.env;
const nowOf = (scope: TrashScope): number => (scope.now ?? Date.now)();
const renameOf = (scope: TrashScope): RenameFn => scope.rename ?? rename;

function backendOf(scope: TrashScope): TrashEntry["backend"] {
	const platform = scope.platform ?? process.platform;
	if (platform === "darwin") return scope.policy.macosTrash === "os" ? "macos" : "freedesktop";
	if (platform === "win32") {
		throw new TrashError("unsupported_platform", "The trash is not supported on Windows yet; nothing was deleted.");
	}
	return "freedesktop";
}

async function purge(scope: TrashScope, entry: TrashEntry, reason: string): Promise<DeleteAuditRow> {
	await rm(entry.trashedPath, { recursive: true, force: true });
	if (entry.infoPath !== null) await rm(entry.infoPath, { force: true });
	await removeEntry(scope.agentDir, entry.id);
	const row: DeleteAuditRow = {
		ts: new Date(nowOf(scope)).toISOString(),
		sessionId: scope.sessionId,
		actor: scope.actor,
		path: entry.originalPath,
		bytes: entry.bytes,
		reason,
		trashId: entry.id,
	};
	await appendDeleteAudit(scope.agentDir, row);
	return row;
}

async function purgeExpired(scope: TrashScope): Promise<DeleteAuditRow[]> {
	const cutoff = nowOf(scope) - scope.policy.retentionDays * DAY_MS;
	const rows: DeleteAuditRow[] = [];
	for (const entry of await readEntries(scope.agentDir)) {
		if (entry.backend === "freedesktop" && entry.deletedAt < cutoff) {
			rows.push(await purge(scope, entry, `retention: older than ${scope.policy.retentionDays} days`));
		}
	}
	return rows;
}

async function freedesktopBytes(
	scope: TrashScope,
): Promise<{ readonly entries: TrashEntry[]; readonly bytes: number }> {
	const entries = (await readEntries(scope.agentDir)).filter((entry) => entry.backend === "freedesktop");
	return { entries, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}

async function moveFreedesktop(
	scope: TrashScope,
	target: string,
): Promise<Omit<TrashEntry, "id" | "sessionId" | "reason">> {
	const env = envOf(scope);
	const uid = process.getuid?.() ?? 0;
	await assertTrashable(target, [homeTrashDir(env)]);
	const trashDir = await freedesktopTrashFor(target, env, uid);
	await assertTrashable(target, [trashDir]);
	await purgeExpired(scope);
	const bytes = await measureBytes(target);
	const cap = await trashCapBytes(scope.policy, trashDir);
	const used = (await freedesktopBytes(scope)).bytes;
	if (used + bytes > cap) {
		throw new TrashError(
			"trash_full",
			`The trash is full: ${used} bytes held, ${bytes} more would pass the ${cap}-byte cap. Nothing was deleted; free space with \`senpi trash empty --older-than <days>d\`.`,
		);
	}
	const deletedAt = nowOf(scope);
	const moved = await moveToFreedesktopTrash(target, trashDir, deletedAt, renameOf(scope));
	return { backend: "freedesktop", originalPath: target, deletedAt, bytes, ...moved };
}

async function moveMac(scope: TrashScope, target: string): Promise<Omit<TrashEntry, "id" | "sessionId" | "reason">> {
	await assertTrashable(target, [join(envOf(scope).HOME ?? homedir(), ".Trash")]);
	const bytes = await measureBytes(target);
	const trashedPath = await moveToMacTrash(target);
	return { backend: "macos", originalPath: target, trashedPath, infoPath: null, deletedAt: nowOf(scope), bytes };
}

/** Moves one target to the trash as a single rename; on any refusal the target is untouched. */
export async function trashPath(scope: TrashScope, target: string, reason: string): Promise<TrashEntry> {
	const absolute = resolve(target);
	const moved = backendOf(scope) === "macos" ? await moveMac(scope, absolute) : await moveFreedesktop(scope, absolute);
	const entry: TrashEntry = { ...moved, id: newEntryId(moved.deletedAt), sessionId: scope.sessionId, reason };
	await writeEntry(scope.agentDir, entry);
	return entry;
}

export async function listTrash(scope: TrashScope): Promise<TrashEntry[]> {
	return readEntries(scope.agentDir);
}

/** Moves an entry back to its original path. Refuses when something already occupies that path. */
export async function restoreTrash(scope: TrashScope, id: string): Promise<TrashEntry> {
	const entry = (await readEntries(scope.agentDir)).find((candidate) => candidate.id === id);
	if (entry === undefined) throw new TrashError("not_found", `No trash entry ${id}.`);
	if (await pathExists(entry.originalPath)) {
		throw new TrashError(
			"restore_collision",
			`${entry.originalPath} already exists; move it away first. The entry stays in the trash.`,
		);
	}
	await mkdir(dirname(entry.originalPath), { recursive: true });
	try {
		await renameOf(scope)(entry.trashedPath, entry.originalPath);
	} catch (error) {
		if (errnoCode(error) === "EXDEV") {
			throw new TrashError("cross_device", `Restoring ${id} would cross devices; it stays in the trash.`);
		}
		throw error;
	}
	if (entry.infoPath !== null) await rm(entry.infoPath, { force: true });
	await removeEntry(scope.agentDir, entry.id);
	return entry;
}

/**
 * Permanently deletes trash entries: always the retention-expired ones, then the selection, then the oldest
 * freedesktop entries until the size cap holds again.
 */
export async function emptyTrash(scope: TrashScope, selection: EmptySelection): Promise<DeleteAuditRow[]> {
	const rows = await purgeExpired(scope);
	const now = nowOf(scope);
	for (const entry of await readEntries(scope.agentDir)) {
		if (selection.kind === "all") rows.push(await purge(scope, entry, "empty: all"));
		else if (selection.kind === "older-than" && entry.deletedAt <= now - selection.ms) {
			rows.push(await purge(scope, entry, `empty: older than ${Math.round(selection.ms / 1000)}s`));
		}
	}
	const { entries, bytes } = await freedesktopBytes(scope);
	if (entries.length === 0) return rows;
	const cap = await trashCapBytes(scope.policy, homeTrashDir(envOf(scope)));
	let held = bytes;
	for (const entry of entries) {
		if (held <= cap) break;
		rows.push(await purge(scope, entry, `size-cap: trash over ${cap} bytes`));
		held -= entry.bytes;
	}
	return rows;
}

/** The explicit, audited permanent delete. A model's request needs a reason and is refused under `trash-only`. */
export async function deletePermanently(scope: TrashScope, target: string, reason: string): Promise<DeleteAuditRow> {
	if (reason.trim().length === 0) throw new TrashError("refused", "A permanent delete needs a non-empty reason.");
	if (scope.actor === "model" && scope.policy.mode === "trash-only") {
		throw new TrashError(
			"refused",
			"deletePolicy is trash-only: only the user can delete permanently. Use the trash.",
		);
	}
	const absolute = resolve(target);
	await assertTrashable(absolute, backendOf(scope) === "freedesktop" ? [homeTrashDir(envOf(scope))] : []);
	const bytes = await measureBytes(absolute);
	await rm(absolute, { recursive: true, force: true });
	const row: DeleteAuditRow = {
		ts: new Date(nowOf(scope)).toISOString(),
		sessionId: scope.sessionId,
		actor: scope.actor,
		path: absolute,
		bytes,
		reason: `permanent: ${reason.trim()}`,
		trashId: null,
	};
	await appendDeleteAudit(scope.agentDir, row);
	return row;
}
