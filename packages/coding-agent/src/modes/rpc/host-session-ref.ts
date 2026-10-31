import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertValidSessionId, SessionManager } from "../../core/session-manager.ts";
import type { RpcClient } from "./rpc-client.ts";
import { canonicalSessionPath } from "./session-path-key.ts";

/** Routing handles last one host epoch; keep a durable id or path across parking and handoff. */
export type SessionRef = string;

export type SessionRow = Awaited<ReturnType<RpcClient["listSessions"]>>[number];

/**
 * Where a reference points. `parked` is a session the host no longer lists (idle park, handoff)
 * whose transcript still exists; `open_session { sessionPath }` resumes it.
 */
export type ResolvedSessionRef =
	| { readonly kind: "live"; readonly row: SessionRow }
	| { readonly kind: "parked"; readonly sessionPath: string; readonly cwd: string; readonly durableSessionId: string }
	| { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
	| { readonly kind: "unknown" };

type Transcript = { readonly path: string; readonly cwd: string; readonly id: string };

/** Resolve anew on every invocation: a durable session can have a new routing handle. */
export async function resolveSessionRef(
	client: Pick<RpcClient, "listSessions">,
	ref: SessionRef,
	agentDir: string,
): Promise<ResolvedSessionRef> {
	const rows = await client.listSessions();
	const handle = rows.find((row) => row.sessionId === ref);
	if (handle) return { kind: "live", row: handle };
	if (isSessionId(ref)) {
		const byId = await resolveDurableId(ref, rows, agentDir);
		if (byId) return byId;
	}
	const named = rows.filter((row) => row.name === ref);
	if (named.length > 1) return { kind: "ambiguous", candidates: named.map((row) => row.sessionId) };
	const live = named[0] ?? rows.find((row) => row.sessionPath !== undefined && samePath(row.sessionPath, ref));
	if (live) return { kind: "live", row: live };
	return looksLikePath(ref) ? parkedByPath(ref) : { kind: "unknown" };
}

/**
 * A durable id names ONE session only when every live row and every transcript carrying it is the
 * same file: two transcripts with one id (a caller-minted id reused while the first was parked) are
 * refused rather than resolved to whichever is listed first.
 */
async function resolveDurableId(
	id: string,
	rows: readonly SessionRow[],
	agentDir: string,
): Promise<ResolvedSessionRef | undefined> {
	const liveRows = rows.filter((row) => row.durableSessionId === id);
	const transcripts = (await transcriptsUnder(agentDir)).filter((session) => session.id === id);
	const files = new Set([
		...liveRows.map((row) => (row.sessionPath === undefined ? row.sessionId : canonicalSessionPath(row.sessionPath))),
		...transcripts.map((session) => canonicalSessionPath(session.path)),
	]);
	if (files.size > 1) return { kind: "ambiguous", candidates: [...files] };
	if (liveRows[0]) return { kind: "live", row: liveRows[0] };
	return transcripts[0] ? parked(transcripts[0]) : undefined;
}

function isSessionId(ref: string): boolean {
	try {
		assertValidSessionId(ref);
		return true;
	} catch {
		return false;
	}
}

function looksLikePath(ref: string): boolean {
	return ref.includes("/") || ref.includes("\\") || ref.endsWith(".jsonl");
}

async function parkedByPath(ref: string): Promise<ResolvedSessionRef> {
	const path = canonicalSessionPath(ref);
	if (!existsSync(path)) return { kind: "unknown" };
	const info = (await SessionManager.listAll(dirname(path))).find((session) => samePath(session.path, path));
	return info ? parked(info) : { kind: "unknown" };
}

/** The host keeps every transcript under `<agentDir>/sessions/<cwd-dir>/`. */
async function transcriptsUnder(agentDir: string): Promise<readonly Transcript[]> {
	const root = join(agentDir, "sessions");
	if (!existsSync(root)) return [];
	const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
	return (await Promise.all(dirs.map((entry) => SessionManager.listAll(join(root, entry.name))))).flat();
}

function parked(info: Transcript): ResolvedSessionRef {
	return { kind: "parked", sessionPath: info.path, cwd: info.cwd, durableSessionId: info.id };
}

function samePath(left: string, right: string): boolean {
	return canonicalSessionPath(left) === canonicalSessionPath(right);
}
