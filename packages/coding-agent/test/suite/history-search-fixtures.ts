import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry } from "../../src/core/extensions/builtin/history-search/types.ts";
import { Theme } from "../../src/modes/interactive/theme/theme.ts";

export const BASE_TIME = Date.parse("2026-05-20T12:00:00.000Z");

const testFgColors = {
	accent: "",
	border: "",
	borderAccent: "",
	borderMuted: "",
	success: "",
	error: "",
	warning: "",
	muted: "",
	dim: "",
	text: "",
	thinkingText: "",
	userMessageText: "",
	customMessageText: "",
	customMessageLabel: "",
	toolTitle: "",
	toolOutput: "",
	mdHeading: "",
	mdLink: "",
	mdLinkUrl: "",
	mdCode: "",
	mdCodeBlock: "",
	mdCodeBlockBorder: "",
	mdQuote: "",
	mdQuoteBorder: "",
	mdHr: "",
	mdListBullet: "",
	toolDiffAdded: "",
	toolDiffRemoved: "",
	toolDiffContext: "",
	syntaxComment: "",
	syntaxKeyword: "",
	syntaxFunction: "",
	syntaxVariable: "",
	syntaxString: "",
	syntaxNumber: "",
	syntaxType: "",
	syntaxOperator: "",
	syntaxPunctuation: "",
	thinkingOff: "",
	thinkingMinimal: "",
	thinkingLow: "",
	thinkingMedium: "",
	thinkingHigh: "",
	thinkingXhigh: "",
	thinkingMax: "",
	bashMode: "",
};

const testBgColors = {
	selectedBg: "",
	userMessageBg: "",
	customMessageBg: "",
	toolPendingBg: "",
	toolSuccessBg: "",
	toolErrorBg: "",
};

export const testTheme = new Theme(testFgColors, testBgColors, "256color");

export function createTempRootRegistry(): { make: () => Promise<string>; cleanup: () => Promise<void> } {
	const roots: string[] = [];
	return {
		make: async () => {
			const root = await mkdtemp(join(tmpdir(), "senpi-history-search-"));
			roots.push(root);
			return root;
		},
		cleanup: async () => {
			for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
		},
	};
}

export function sessionLine(sessionId = "session-1", cwd = "/workspace", timestamp = BASE_TIME): string {
	return JSON.stringify({ type: "session", id: sessionId, timestamp: new Date(timestamp).toISOString(), cwd });
}

export function userLine(textParts: readonly string[], timestamp = BASE_TIME + 1_000): string {
	return JSON.stringify({
		type: "message",
		id: `msg-${timestamp}`,
		parentId: "parent",
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: textParts.map((text) => ({ type: "text", text })) },
	});
}

export async function writeSessionFile(
	sessionsDir: string,
	fileName: string,
	lines: readonly string[],
): Promise<string> {
	const dir = join(sessionsDir, "encoded-cwd");
	await mkdir(dir, { recursive: true });
	const file = join(dir, fileName);
	await writeFile(file, `${lines.join("\n")}\n`, "utf-8");
	return file;
}

export function historyEntry(text: string, timestamp: number): HistoryEntry {
	return { text, sessionId: "s", sessionFile: "/tmp/s.jsonl", cwd: "/repo", timestamp };
}
