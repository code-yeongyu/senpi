import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionManager } from "../../../src/core/session-manager.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function sessionLines(dir: string, keyed: boolean): readonly object[] {
	const part = (id: string, key: string) => ({
		type: "toolCall",
		id,
		name: "bash",
		arguments: { command: "true" },
		...(keyed ? { runtimeItemKey: key } : {}),
	});
	const result = (id: string, parentId: string, toolCallId: string, mark: object) => ({
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-02T00:00:02.000Z",
		...(keyed ? mark : {}),
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2,
		},
	});
	return [
		{ type: "session", version: 3, id: "s-5374", timestamp: "2026-11-02T00:00:00.000Z", cwd: dir },
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-11-02T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [part("dup", "k:1.0"), part("dup", "k:1.1"), part("solo", "k:1.2")],
				api: "openai-completions",
				provider: "openai",
				model: "test-model",
				usage,
				stopReason: "toolUse",
				timestamp: 1,
			},
		},
		result("r1", "a1", "dup", { callUnknown: true }),
		result("r2", "r1", "dup", { callUnknown: true }),
		result("r3", "r2", "solo", { runtimeItemKey: "k:1.2" }),
	];
}

export function writeSession(dir: string, keyed: boolean, name = "session.jsonl"): string {
	const file = join(dir, name);
	writeFileSync(
		file,
		`${sessionLines(dir, keyed)
			.map((line) => JSON.stringify(line))
			.join("\n")}\n`,
	);
	return file;
}

/** The keys `session` persists on entry `entryId`'s toolCall parts, read through the copy the file holds. */
export function persistedPartKeys(session: SessionManager, entryId: string): (string | undefined)[] {
	const entry = session.getEntry(entryId);
	if (entry?.type !== "message" || entry.message.role !== "assistant") return [];
	const persisted = session.persistedEntry(entry);
	const content: { type?: string; runtimeItemKey?: string }[] =
		persisted.type === "message" ? Reflect.get(persisted.message, "content") : [];
	return content.filter((part) => part.type === "toolCall").map((part) => part.runtimeItemKey);
}
