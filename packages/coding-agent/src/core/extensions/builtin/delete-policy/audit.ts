import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type DeleteActor = "model" | "user" | "engine";

/** One permanent delete. Every path that destroys data for good appends exactly one row per target. */
export interface DeleteAuditRow {
	readonly ts: string;
	readonly sessionId: string | null;
	readonly actor: DeleteActor;
	readonly path: string;
	readonly bytes: number;
	readonly reason: string;
	readonly trashId: string | null;
}

export function deleteAuditFile(agentDir: string): string {
	return join(agentDir, "audit", "deletes.jsonl");
}

export async function appendDeleteAudit(agentDir: string, row: DeleteAuditRow): Promise<void> {
	const file = deleteAuditFile(agentDir);
	await mkdir(join(agentDir, "audit"), { recursive: true, mode: 0o700 });
	await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(file, 0o600);
}
