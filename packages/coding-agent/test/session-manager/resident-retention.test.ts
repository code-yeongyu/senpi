import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const SENTINEL_PREFIX = "\\u0000senpi-resident-string:v1:";

function largeText(label: string): string {
	return `${label}: ${"x".repeat(40 * 1024)}`;
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

function defined<T>(value: T | undefined, name: string): T {
	if (value === undefined) {
		throw new Error(`${name} should be defined`);
	}
	return value;
}

describe("SessionManager resident retention", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-resident-retention-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("bounds resident strings while materializing public readers and persisted JSONL", () => {
		const userText = largeText("user");
		const assistantText = largeText("assistant");
		const session = SessionManager.create(tempDir, tempDir);

		const userId = session.appendMessage({ role: "user", content: userText, timestamp: 1 });
		const assistantId = session.appendMessage(assistantMessage(assistantText));

		expect(session.getResidentStoreStats().blobCount).toBeGreaterThanOrEqual(2);

		const userEntry = session.getEntry(userId);
		expect(userEntry?.type).toBe("message");
		if (userEntry?.type === "message") {
			if (!("content" in userEntry.message)) {
				throw new Error("user message should have content");
			}
			expect(userEntry.message.content).toBe(userText);
		}

		const assistantEntry = session.getEntry(assistantId);
		expect(assistantEntry?.type).toBe("message");
		if (assistantEntry?.type === "message") {
			if (!("content" in assistantEntry.message) || !Array.isArray(assistantEntry.message.content)) {
				throw new Error("assistant message should have content blocks");
			}
			const firstBlock = assistantEntry.message.content[0];
			expect(firstBlock?.type).toBe("text");
			if (firstBlock?.type !== "text") {
				throw new Error("assistant content should start with text");
			}
			expect(firstBlock.text).toBe(assistantText);
		}

		const branch = session.getBranch();
		expect(JSON.stringify(branch)).not.toContain(SENTINEL_PREFIX);
		expect(JSON.stringify(session.getEntries())).not.toContain(SENTINEL_PREFIX);

		const context = session.buildSessionContext();
		expect(context.messages[0]).toEqual({ role: "user", content: userText, timestamp: 1 });
		expect(JSON.stringify(context.messages[1])).toContain(assistantText);

		const sessionFile = defined(session.getSessionFile(), "session file");
		expect(existsSync(sessionFile)).toBe(true);
		const persisted = readFileSync(sessionFile, "utf8");
		expect(persisted).not.toContain(SENTINEL_PREFIX);
		expect(persisted).toContain(userText);
		expect(persisted).toContain(assistantText);
	});

	it("materializes reloads, branched sessions, and forked sessions without leaking sentinels", () => {
		const firstText = largeText("first");
		const secondText = largeText("second");
		const session = SessionManager.create(tempDir, tempDir);
		const firstId = session.appendMessage({ role: "user", content: firstText, timestamp: 1 });
		const firstAssistantId = session.appendMessage(assistantMessage("small assistant"));
		const secondId = session.appendMessage({ role: "user", content: secondText, timestamp: 3 });
		session.appendMessage(assistantMessage("second assistant"));

		const sessionFile = defined(session.getSessionFile(), "session file");

		const reloaded = SessionManager.open(sessionFile, tempDir);
		expect(reloaded.getResidentStoreStats().blobCount).toBeGreaterThanOrEqual(2);
		expect(reloaded.buildSessionContext().messages[0]).toEqual({ role: "user", content: firstText, timestamp: 1 });

		const branchedFile = defined(reloaded.createBranchedSession(firstAssistantId), "branched file");
		expect(readFileSync(branchedFile, "utf8")).not.toContain(SENTINEL_PREFIX);
		expect(reloaded.buildSessionContext().messages[0]).toEqual({ role: "user", content: firstText, timestamp: 1 });
		expect(JSON.stringify(reloaded.buildSessionContext().messages)).not.toContain(secondText);

		const forked = SessionManager.forkFrom(sessionFile, join(tempDir, "forked-cwd"), tempDir, {
			id: "resident-fork",
		});
		const forkedContext = forked.buildSessionContext();
		expect(JSON.stringify(forkedContext.messages)).toContain(firstText);
		expect(JSON.stringify(forkedContext.messages)).toContain(secondText);
		const forkedFile = defined(forked.getSessionFile(), "forked file");
		expect(readFileSync(forkedFile, "utf8")).not.toContain(SENTINEL_PREFIX);
		expect(secondId).toBeTruthy();
		expect(firstId).toBeTruthy();
	});
});
