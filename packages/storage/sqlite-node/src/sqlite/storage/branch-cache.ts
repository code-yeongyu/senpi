import { uuidv7 } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "../types.ts";
import type { SessionEntryRow } from "./session-entries.ts";
import { invalidSession } from "./shared.ts";

/** Derived root-to-tip paths. Canonical parent links remain authoritative. */
export interface CachedBranch {
	branchId: string;
	leafSeq: number;
}

export async function readCachedBranch(
	db: SqliteDatabase,
	sessionId: string,
	leafId: string,
): Promise<CachedBranch | undefined> {
	const membership = await db
		.prepare(
			"SELECT branch_id, entry_seq FROM branch_entries WHERE session_id = ? AND entry_id = ? ORDER BY branch_id LIMIT 1",
		)
		.get<{ branch_id: string; entry_seq: number }>(sessionId, leafId);
	if (!membership) return undefined;
	return { branchId: membership.branch_id, leafSeq: membership.entry_seq };
}

export async function readCachedBranchRows(
	db: SqliteDatabase,
	sessionId: string,
	branch: CachedBranch,
	startSeq: number,
): Promise<SessionEntryRow[]> {
	return db
		.prepare(
			`SELECT e.session_id, e.id, e.entry_seq, e.parent_id, e.type, e.timestamp, e.payload
			FROM branch_entries AS b
			JOIN session_entries AS e ON e.session_id = b.session_id AND e.id = b.entry_id
			WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq BETWEEN ? AND ?
			ORDER BY b.entry_seq`,
		)
		.all<SessionEntryRow>(sessionId, branch.branchId, startSeq, branch.leafSeq);
}

export async function readCachedEntryRowsByType(
	db: SqliteDatabase,
	sessionId: string,
	branch: CachedBranch,
	type: SessionEntryRow["type"],
): Promise<SessionEntryRow[]> {
	return db
		.prepare(
			`SELECT e.session_id, e.id, e.entry_seq, e.parent_id, e.type, e.timestamp, e.payload
			FROM branch_entries AS b
			JOIN session_entries AS e ON e.session_id = b.session_id AND e.id = b.entry_id
			WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq <= ? AND e.type = ?
			ORDER BY b.entry_seq DESC`,
		)
		.all<SessionEntryRow>(sessionId, branch.branchId, branch.leafSeq, type);
}

export async function readCachedEntrySeq(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	entryId: string,
): Promise<number | undefined> {
	const row = await db
		.prepare("SELECT entry_seq FROM branch_entries WHERE session_id = ? AND branch_id = ? AND entry_id = ?")
		.get<{ entry_seq: number }>(sessionId, branchId, entryId);
	return row?.entry_seq;
}

export async function rebuildCachedBranch(
	db: SqliteDatabase,
	sessionId: string,
	leafId: string,
	branchIdToReplace?: string,
): Promise<void> {
	await db.exec("SAVEPOINT rebuild_branch_cache");
	try {
		const tip = await db
			.prepare("SELECT branch_id FROM branch_tips WHERE session_id = ? AND tip_id = ?")
			.get<{ branch_id: string }>(sessionId, leafId);
		const branchIds = new Set([branchIdToReplace, tip?.branch_id].filter((id): id is string => id !== undefined));
		for (const branchId of branchIds) {
			await db.prepare("DELETE FROM branch_tips WHERE session_id = ? AND branch_id = ?").run(sessionId, branchId);
			await db.prepare("DELETE FROM branch_entries WHERE session_id = ? AND branch_id = ?").run(sessionId, branchId);
		}

		const branchId = uuidv7();
		await db
			.prepare(
				`WITH RECURSIVE path(id, entry_seq, parent_id) AS (
					SELECT id, entry_seq, parent_id
					FROM session_entries
					WHERE session_id = ? AND id = ?
					UNION ALL
					SELECT parent.id, parent.entry_seq, parent.parent_id
					FROM session_entries AS parent
					JOIN path AS child ON child.parent_id = parent.id
					WHERE parent.session_id = ?
				)
				INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq)
				SELECT ?, ?, id, entry_seq FROM path`,
			)
			.run(sessionId, leafId, sessionId, sessionId, branchId);
		await db
			.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)")
			.run(sessionId, leafId, branchId);
		await db.exec("RELEASE SAVEPOINT rebuild_branch_cache");
	} catch (error) {
		try {
			await db.exec("ROLLBACK TO SAVEPOINT rebuild_branch_cache");
			await db.exec("RELEASE SAVEPOINT rebuild_branch_cache");
		} catch {
			// Preserve the original repair failure.
		}
		throw error;
	}
}

async function extendBranch(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	parentId: string,
	entryId: string,
	entrySeq: number,
): Promise<void> {
	await db
		.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
		.run(sessionId, branchId, entryId, entrySeq);
	const result = await db
		.prepare("UPDATE branch_tips SET tip_id = ? WHERE session_id = ? AND branch_id = ? AND tip_id = ?")
		.run(entryId, sessionId, branchId, parentId);
	if (result.changes !== 1) throw invalidSession(`branch tip ${parentId} changed during append`);
}

export async function appendEntryToBranchCache(
	db: SqliteDatabase,
	sessionId: string,
	entryId: string,
	entrySeq: number,
	parentId: string | null,
	repairParent: (parentId: string) => Promise<void>,
): Promise<void> {
	if (parentId === null) {
		const branchId = uuidv7();
		await db
			.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
			.run(sessionId, branchId, entryId, entrySeq);
		await db
			.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)")
			.run(sessionId, entryId, branchId);
		return;
	}

	let tip = await db
		.prepare("SELECT branch_id FROM branch_tips WHERE session_id = ? AND tip_id = ?")
		.get<{ branch_id: string }>(sessionId, parentId);
	if (tip) {
		await extendBranch(db, sessionId, tip.branch_id, parentId, entryId, entrySeq);
		return;
	}

	const source = await db
		.prepare(
			`SELECT b.branch_id, b.entry_seq
			FROM branch_entries AS b
			WHERE b.session_id = ? AND b.entry_id = ?
			ORDER BY b.branch_id
			LIMIT 1`,
		)
		.get<{ branch_id: string; entry_seq: number }>(sessionId, parentId);
	if (!source) {
		await repairParent(parentId);
		tip = await db
			.prepare("SELECT branch_id FROM branch_tips WHERE session_id = ? AND tip_id = ?")
			.get<{ branch_id: string }>(sessionId, parentId);
		if (!tip) throw invalidSession(`branch cache repair did not create tip ${parentId}`);
		await extendBranch(db, sessionId, tip.branch_id, parentId, entryId, entrySeq);
		return;
	}

	const branchId = uuidv7();
	await db
		.prepare(
			`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq)
			SELECT session_id, ?, entry_id, entry_seq
			FROM branch_entries
			WHERE session_id = ? AND branch_id = ? AND entry_seq <= ?`,
		)
		.run(branchId, sessionId, source.branch_id, source.entry_seq);
	await db
		.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
		.run(sessionId, branchId, entryId, entrySeq);
	await db
		.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)")
		.run(sessionId, entryId, branchId);
}
