import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "../../types.ts";

/** Child tasks of this session whose record on disk says they are pending or running. */
export function countRunningChildTasks(ctx: ExtensionContext, debug: (message: string) => void): number {
	const directory = join(ctx.cwd, ".omo", "senpi-task", "tasks");
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			debug("Child-task directory unavailable");
		return 0;
	}
	let count = 0;
	for (const file of entries) {
		if (!file.endsWith(".json")) continue;
		try {
			const record: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
			if (
				typeof record !== "object" ||
				record === null ||
				!("status" in record) ||
				(record.status !== "running" && record.status !== "pending")
			)
				continue;
			const sessionId = ctx.sessionManager.getSessionId();
			if (
				("root_session_id" in record && record.root_session_id === sessionId) ||
				("parent_session_id" in record && record.parent_session_id === sessionId)
			)
				count++;
		} catch {
			// Task records are an external, concurrently-written boundary. Retry on the next refresh.
			debug("Ignored an unreadable or partial child-task record");
		}
	}
	return count;
}
