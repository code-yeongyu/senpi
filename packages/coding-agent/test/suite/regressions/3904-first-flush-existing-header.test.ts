import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function headerWrittenBySecondManager() {
	const dir = mkdtempSync(join(tmpdir(), "first-flush-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	const path = manager.getSessionFile();
	if (!path) throw new Error("expected a minted session path");
	SessionManager.open(path, dir, dir);
	return { manager, path };
}

it("keeps the second manager's header and persists the minting manager's first conversation", () => {
	const { manager, path } = headerWrittenBySecondManager();
	const originalHeader = readFileSync(path, "utf8");
	const setupId = manager.appendModelChange("test", "local");
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("reply"));
	const transcript = readFileSync(path, "utf8");
	expect(transcript.startsWith(originalHeader)).toBe(true);
	const entries = transcript
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(entries.map((entry) => entry.type)).toEqual(["session", "model_change", "message", "message"]);
	expect(entries[0].id).toBe(manager.getSessionId());
	expect(manager.getHeader()).toEqual(entries[0]);
	expect(entries[1].id).toBe(setupId);
	expect(entries[2].parentId).toBe(setupId);
	expect(entries.slice(2).map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
});

it("does not adopt a transcript that has advanced beyond the header", () => {
	const { manager, path } = headerWrittenBySecondManager();
	const existing = SessionManager.open(path);
	existing.appendMessage({ role: "user", content: "already persisted", timestamp: 1 });
	const before = readFileSync(path, "utf8");
	expect(() => manager.appendMessage({ role: "user", content: "different branch", timestamp: 2 })).toThrow();
	expect(readFileSync(path, "utf8")).toBe(before);
});

it("refuses a different header ID without changing the existing file", () => {
	const { manager, path } = headerWrittenBySecondManager();
	const header = JSON.parse(readFileSync(path, "utf8"));
	const other = `${JSON.stringify({ ...header, id: "different-session" })}\n`;
	writeFileSync(path, other);
	expect(() => manager.appendMessage({ role: "user", content: "hello", timestamp: 1 })).toThrow();
	expect(readFileSync(path, "utf8")).toBe(other);
});
