import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { sessionLines, writeSession } from "./5374-call-key-fixture-support.ts";

// RULING-126 (senpi#5374) (1b) and (4): a session file is read by one shared loader. A file written by a senpi that
// persists the call key (`runtimeItemKey` on a toolCall part, `runtimeItemKey` or `callUnknown: true` on a toolResult
// entry) must load in a reader that knows nothing of those fields, and a file written before them must load exactly as
// it is, with no migration and no rewrite.

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-5374-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

it("RULING-126 (1b) #5374 a file carrying call keys loads in the shared reader with every call intact", () => {
	const file = writeSession(dir, true);
	const session = SessionManager.open(file, dir);
	expect(session.getEntries().map((entry) => entry.id)).toEqual(["a1", "r1", "r2", "r3"]);
	const messages = session.buildSessionContext().messages;
	expect(messages.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult", "toolResult"]);
	const [assistant] = messages;
	if (assistant?.role !== "assistant") throw new Error("expected the assistant message first");
	expect(assistant.content).toMatchObject([
		{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "true" } },
		{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "true" } },
		{ type: "toolCall", id: "solo", name: "bash", arguments: { command: "true" } },
	]);
	expect(messages.slice(1).map((message) => (message.role === "toolResult" ? message.toolCallId : null))).toEqual([
		"dup",
		"dup",
		"solo",
	]);
	expect(JSON.stringify(session.getEntries())).not.toMatch(/runtimeItemKey|callUnknown/);
	expect([0, 1, 2].map((index) => session.getToolCallKey("a1", index))).toEqual(["k:1.0", "k:1.1", "k:1.2"]);
});

it("RULING-127 (d) #5374 an old session's toolCall parts get load-time keys, stable in one load and never written", () => {
	const file = writeSession(dir, false);
	const before = readFileSync(file, "utf8");
	const keysOf = (session: SessionManager) => [0, 1, 2].map((index) => session.getToolCallKey("a1", index));
	const first = SessionManager.open(file, dir);
	const minted = keysOf(first);
	expect(minted.every((key) => typeof key === "string")).toBe(true);
	expect(new Set(minted).size).toBe(3);
	expect(keysOf(first)).toEqual(minted);
	expect(keysOf(SessionManager.open(file, dir)).some((key) => minted.includes(key))).toBe(false);
	expect(readFileSync(file, "utf8")).toBe(before);
});

it("RULING-126 (4) #5374 a session written before call keys loads unchanged, with no migration or rewrite", () => {
	const file = writeSession(dir, false);
	const before = readFileSync(file, "utf8");
	const session = SessionManager.open(file, dir);
	expect(session.getEntries()).toEqual(sessionLines(dir, false).slice(1));
	expect(readFileSync(file, "utf8")).toBe(before);
});
