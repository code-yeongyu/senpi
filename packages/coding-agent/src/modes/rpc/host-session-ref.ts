import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "../../core/session-manager.ts";
import type { RpcClient } from "./rpc-client.ts";

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

/** Resolve anew on every invocation: a durable session can have a new routing handle. */
export async function resolveSessionRef(
	client: Pick<RpcClient, "listSessions">,
	ref: SessionRef,
	agentDir: string,
): Promise<ResolvedSessionRef> {
	const rows = await client.listSessions();
	const unique = rows.find((row) => row.sessionId === ref) ?? rows.find((row) => row.durableSessionId === ref);
	if (unique) return { kind: "live", row: unique };
	const named = rows.filter((row) => row.name === ref);
	if (named.length > 1) return { kind: "ambiguous", candidates: named.map((row) => row.sessionId) };
	const live = named[0] ?? rows.find((row) => row.sessionPath !== undefined && samePath(row.sessionPath, ref));
	if (live) return { kind: "live", row: live };
	return looksLikePath(ref) ? parkedByPath(ref) : parkedByDurableId(ref, agentDir);
}

function looksLikePath(ref: string): boolean {
	return ref.includes("/") || ref.includes("\\") || ref.endsWith(".jsonl");
}

async function parkedByPath(ref: string): Promise<ResolvedSessionRef> {
	const path = resolve(ref);
	if (!existsSync(path)) return { kind: "unknown" };
	const info = (await SessionManager.listAll(dirname(path))).find((session) => samePath(session.path, path));
	return info ? parked(info) : { kind: "unknown" };
}

/** The host keeps every transcript under `<agentDir>/sessions/<cwd-dir>/`; an exact id names one file. */
async function parkedByDurableId(id: string, agentDir: string): Promise<ResolvedSessionRef> {
	const root = join(agentDir, "sessions");
	if (!existsSync(root)) return { kind: "unknown" };
	const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
	const matches = (await Promise.all(dirs.map((entry) => SessionManager.listAll(join(root, entry.name)))))
		.flat()
		.filter((session) => session.id === id);
	if (matches.length > 1) return { kind: "ambiguous", candidates: matches.map((session) => session.path) };
	return matches[0] ? parked(matches[0]) : { kind: "unknown" };
}

function parked(info: { path: string; cwd: string; id: string }): ResolvedSessionRef {
	return { kind: "parked", sessionPath: info.path, cwd: info.cwd, durableSessionId: info.id };
}

function samePath(left: string, right: string): boolean {
	const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
	return canonical(left) === canonical(right);
}
