import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionHeader } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function createSessionFile(path: string, timestamp: number): void {
	const header: SessionHeader = {
		type: "session",
		id: "test-session",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp",
	};
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");

	// SessionManager only persists once it has seen at least one assistant message.
	// Add a minimal assistant entry so subsequent appends are persisted.
	const mgr = SessionManager.open(path);
	mgr.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	});
}

describe("SessionInfo.modified", () => {
	it("uses last user/assistant message timestamp instead of file mtime", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-session-info-"));
		const filePath = join(sessionDir, "session.jsonl");
		const initialMessageTime = Date.UTC(2025, 0, 1);
		const msgTime = Date.UTC(2025, 0, 2);
		const fileMtime = new Date(Date.UTC(2025, 0, 3));

		try {
			createSessionFile(filePath, initialMessageTime);

			const mgr = SessionManager.open(filePath);
			mgr.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "later" }],
				api: "openai-completions",
				provider: "openai",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: msgTime,
			});

			utimesSync(filePath, fileMtime, fileMtime);

			const sessions = await SessionManager.list("/tmp", sessionDir);
			const s = sessions.find((x) => x.path === filePath);
			expect(s).toBeDefined();
			expect(s!.modified.getTime()).toBe(msgTime);
			expect(s!.modified.getTime()).not.toBe(fileMtime.getTime());
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
