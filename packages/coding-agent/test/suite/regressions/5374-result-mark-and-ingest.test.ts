import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type FileEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { sessionLines } from "./5374-call-key-fixture-support.ts";

// RULING-126 (2) (senpi#5374, #5394 review): every toolResult entry a session writes says which call it closes, or that
// it cannot vouch for one: `runtimeItemKey` only when its id names exactly one open, keyed toolCall part of the latest
// assistant entry, else `callUnknown: true`, never neither. And entries handed to an in-memory session load like a file:
// their persisted keys leave the entries and come back only on the persisted copy.

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-5374-result-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const result = (toolCallId: string) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName: "bash",
	content: [{ type: "text" as const, text: "ok" }],
	isError: false,
	timestamp: 2,
});

it("RULING-126 (2) #5374 a result of a closed call or of no keyed part says callUnknown, never neither", () => {
	const session = SessionManager.create(dir, dir);
	session.appendMessage({ role: "user", content: "go", timestamp: 0 });
	session.appendOwnedMessage(
		fauxAssistantMessage([fauxToolCall("bash", {}, { id: "solo" })], { stopReason: "toolUse" }),
	);
	for (const id of ["solo", "solo", "ghost"]) session.appendMessage(result(id));
	const lines = readFileSync(session.getSessionFile() ?? expect.unreachable("no file"), "utf8")
		.trim()
		.split("\n");
	const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
	const part = entries.find((entry) => (entry.message as { role?: string } | undefined)?.role === "assistant");
	const key = (part?.message as { content?: { runtimeItemKey?: string }[] } | undefined)?.content?.[0]?.runtimeItemKey;
	const marks = entries
		.filter((entry) => (entry.message as { role?: string } | undefined)?.role === "toolResult")
		.map((entry) => [entry.runtimeItemKey ?? null, entry.callUnknown ?? null]);
	expect(key).toMatch(/^blk:/);
	expect(marks).toEqual([
		[key, null],
		[null, true],
		[null, true],
	]);
});

it("RULING-127 (c) #5374 entries ingested into an in-memory session lose their keys in memory and keep them persisted", () => {
	const entries = JSON.parse(JSON.stringify(sessionLines(dir, true))) as FileEntry[];
	const session = SessionManager.inMemory(dir, undefined, entries);
	expect(JSON.stringify(session.getEntries())).not.toMatch(/runtimeItemKey|callUnknown/);
	const persisted = (id: string) => session.persistedEntry(session.getEntry(id) ?? expect.unreachable(id));
	expect(persisted("a1")).toMatchObject({
		message: { content: [{ runtimeItemKey: "k:1.0" }, { runtimeItemKey: "k:1.1" }, { runtimeItemKey: "k:1.2" }] },
	});
	expect(persisted("r1")).toMatchObject({ callUnknown: true });
	expect(persisted("r3")).toMatchObject({ runtimeItemKey: "k:1.2" });
});
