/**
 * `find_session` (senpi#6429): which session FILE of THIS host carries a durable id. A client that binds a thread to a
 * session on another machine keeps the routing key and the durable id, not the path; when that session is closed and
 * unlisted (a move that was given back after its release leaves the file writable and the session not open), the key
 * names nothing and `open_session` has no path to take. This answers the path and the folder its header names.
 *
 * It is a read: it opens, claims, unloads, seals and rewrites nothing, and touches no move record. It reads only this
 * host's own session folder, never a path from the request, which carries the durable id alone. It is bounded: a host
 * with more session files than `FIND_SESSION_FILE_LIMIT` answers a typed error instead of a partial answer, and no
 * file is read before that bound is decided.
 */
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RpcResponse } from "./rpc-types.ts";
import { canonicalSessionPath } from "./session-path-key.ts";

/** Session files this host may hold before one lookup refuses rather than walking them all. */
export const FIND_SESSION_FILE_LIMIT = 20_000;
/** A session header is the file's first line; it carries the id and the folder and nothing else is read. */
const HEADER_READ_BYTES = 64 * 1024;
const READERS = 16;

export class FindSessionTooManyError extends Error {
	readonly code = "find_session_too_many";

	constructor(limit: number) {
		super(
			`This device keeps more than ${limit} session files, so a lookup by durable id was not run. Open the session by its path instead.`,
		);
		this.name = "FindSessionTooManyError";
	}
}

/** `open` says an engine of this host holds the session now, so a caller knows whether it is reopening or attaching. */
export type FindSessionAnswer =
	| { readonly found: { readonly sessionPath: string; readonly cwd: string; readonly open: boolean } }
	| { readonly ambiguous: true }
	| { readonly unknown: true };

/** One live session as the host lists it; only its durable id, file and folder are read. */
export interface HostedSession {
	readonly durableSessionId?: string | undefined;
	readonly sessionPath?: string | undefined;
	readonly cwd?: string | undefined;
}

export interface FindSessionOptions {
	readonly agentDir: string;
	readonly durableSessionId: string;
	readonly hosted: readonly HostedSession[];
}

interface Candidate {
	readonly sessionPath: string;
	readonly cwd: string;
	readonly open: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The file's first line, read whole or not at all; anything that is not a session header is not a candidate. */
async function headerOf(file: string): Promise<{ id: string; cwd: string } | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(file, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.allocUnsafe(HEADER_READ_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
		const data = buffer.subarray(0, bytesRead);
		const newline = data.indexOf(0x0a);
		if (newline === -1 && bytesRead === HEADER_READ_BYTES) return undefined;
		const header: unknown = JSON.parse(data.subarray(0, newline === -1 ? bytesRead : newline).toString("utf8"));
		if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string") return undefined;
		return { id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "" };
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

/** Every session file of this host, counted before any of them is opened. */
async function sessionFiles(agentDir: string): Promise<string[]> {
	const root = join(agentDir, "sessions");
	const folders = await readdir(root, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const folder of folders) {
		if (!folder.isDirectory()) continue;
		const names = await readdir(join(root, folder.name)).catch(() => []);
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			if (files.length >= FIND_SESSION_FILE_LIMIT) throw new FindSessionTooManyError(FIND_SESSION_FILE_LIMIT);
			files.push(join(root, folder.name, name));
		}
	}
	return files;
}

/** A host without an agent directory (the worker runtime) keeps no session files to look in. */
export const RPC_ERROR_FIND_SESSION_UNSUPPORTED = "find_session_unsupported";
export const RPC_ERROR_FIND_SESSION_TOO_MANY = "find_session_too_many";

export interface FindSessionPort {
	readonly agentDir: string | undefined;
	hosted(): readonly HostedSession[];
}

function answer(id: string | undefined, data: FindSessionAnswer): RpcResponse {
	return { id, type: "response", command: "find_session", success: true, data };
}

function refusal(id: string | undefined, code: string, detail: string): RpcResponse {
	return {
		id,
		type: "response",
		command: "find_session",
		success: false,
		error: code,
		errorCode: code,
		errorData: { detail },
	};
}

/** The RPC face: it decides nothing itself beyond the request's shape and this host's own folder. */
export async function findSession(
	port: FindSessionPort,
	command: { readonly id?: string; readonly durableSessionId?: unknown },
): Promise<RpcResponse> {
	const durableSessionId = command.durableSessionId;
	if (typeof durableSessionId !== "string" || durableSessionId.trim() === "")
		return refusal(command.id, "invalid_argument", "find_session needs durableSessionId, the session's own id.");
	if (port.agentDir === undefined)
		return refusal(
			command.id,
			RPC_ERROR_FIND_SESSION_UNSUPPORTED,
			"This host keeps no agent directory, so it holds no session files to look in.",
		);
	try {
		return answer(
			command.id,
			await findSessionFile({ agentDir: port.agentDir, durableSessionId, hosted: port.hosted() }),
		);
	} catch (cause) {
		if (cause instanceof FindSessionTooManyError)
			return refusal(command.id, RPC_ERROR_FIND_SESSION_TOO_MANY, cause.message);
		throw cause;
	}
}

export async function findSessionFile(options: FindSessionOptions): Promise<FindSessionAnswer> {
	const files = await sessionFiles(options.agentDir);
	const byPath = new Map<string, Candidate>();
	for (const row of options.hosted) {
		if (row.durableSessionId !== options.durableSessionId || row.sessionPath === undefined) continue;
		byPath.set(canonicalSessionPath(row.sessionPath), {
			sessionPath: row.sessionPath,
			cwd: row.cwd ?? "",
			open: true,
		});
	}
	for (let index = 0; index < files.length; index += READERS) {
		const batch = files.slice(index, index + READERS);
		const headers = await Promise.all(batch.map((file) => headerOf(file)));
		batch.forEach((file, offset) => {
			const header = headers[offset];
			if (header?.id !== options.durableSessionId) return;
			const key = canonicalSessionPath(file);
			// A hosted row for the same file already says an engine holds it; the file never takes that back.
			if (byPath.has(key)) return;
			byPath.set(key, { sessionPath: file, cwd: header.cwd, open: false });
		});
	}
	const found = [...byPath.values()];
	if (found.length === 0) return { unknown: true };
	if (found.length > 1) return { ambiguous: true };
	return { found: found[0] as Candidate };
}
