import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { RpcClient } from "./rpc-client.ts";

/** Routing handles last one host epoch; keep a durable id or path across parking and handoff. */
export type SessionRef = string;

export type SessionRow = Awaited<ReturnType<RpcClient["listSessions"]>>[number];

/** Resolve anew on every invocation: a durable session can have a new routing handle. */
export async function resolveSessionRow(
	client: Pick<RpcClient, "listSessions">,
	ref: SessionRef,
): Promise<SessionRow | undefined> {
	const rows = await client.listSessions();
	return (
		rows.find((row) => row.sessionId === ref) ??
		rows.find((row) => row.durableSessionId === ref) ??
		rows.find((row) => row.name === ref) ??
		rows.find((row) => row.sessionPath !== undefined && samePath(row.sessionPath, ref))
	);
}

function samePath(left: string, right: string): boolean {
	const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
	return canonical(left) === canonical(right);
}
