import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SearchSessionOptions = {
	readonly userTimestamp?: string;
	readonly assistantTimestamp?: string;
};

export async function writeSearchSession(
	root: string,
	threadId: string,
	text: string,
	options: SearchSessionOptions = {},
): Promise<string> {
	const sessionDir = join(root, "sessions");
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `2026-07-02T00-00-00-000Z_${threadId}.jsonl`);
	const messages = [
		JSON.stringify({
			type: "message",
			id: `message-${threadId}`,
			parentId: threadId,
			timestamp: options.userTimestamp ?? "2026-07-02T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text }] },
		}),
	];
	if (options.assistantTimestamp) {
		messages.push(
			JSON.stringify({
				type: "message",
				id: `assistant-${threadId}`,
				parentId: `message-${threadId}`,
				timestamp: options.assistantTimestamp,
				message: { role: "assistant", content: [{ type: "text", text: "assistant activity" }] },
			}),
		);
	}
	await writeFile(
		sessionFile,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: threadId,
				timestamp: "2026-07-02T00:00:00.000Z",
				cwd: root,
			}),
			...messages,
			"",
		].join("\n"),
	);
	return threadId;
}
