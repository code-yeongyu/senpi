import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";
import { persistedPartKeys } from "./5374-call-key-fixture-support.ts";

// RULING-126 (2) and RULING-127 (i), (ii), (c) (senpi#5374): a real session writes the call key of every toolCall part
// and of the toolResult entry that maps to exactly one open call; a reused id inside one message is marked callUnknown
// instead. A reload reuses each persisted key, two incarnations never mint the same key, and every rewrite of the file
// writes the keys back.

const BLOCK_KEY = /^blk:[0-9a-f-]{36}:\d+$/;
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const noop: AgentTool = {
	name: "noop",
	label: "Noop",
	description: "Noop",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
};

type Line = { type?: string; id?: string; runtimeItemKey?: string; callUnknown?: boolean; message?: Message };
type Message = { role?: string; toolCallId?: string; content?: { type?: string; runtimeItemKey?: string }[] };

const linesOf = (file: string): Line[] =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Line);
const ofRole = (lines: readonly Line[], role: string) =>
	lines.filter((line) => line.type === "message" && line.message?.role === role);
const partKeys = (line: Line) =>
	(line.message?.content ?? []).filter((part) => part.type === "toolCall").map((part) => part.runtimeItemKey);

/** Every persisted call key of a file: part keys per assistant entry, and each result's (toolCallId, key, mark). */
function keysOf(file: string) {
	const lines = linesOf(file);
	return {
		parts: ofRole(lines, "assistant").map((line) => [line.id, partKeys(line)]),
		results: ofRole(lines, "toolResult")
			.map((line) => [line.message?.toolCallId, line.runtimeItemKey ?? null, line.callUnknown ?? null])
			.sort((a, b) => String(a).localeCompare(String(b))),
	};
}

async function runTurn(sessionManager?: SessionManager): Promise<string> {
	const harness = await createHarness({
		tools: [noop],
		persistSession: true,
		...(sessionManager && { sessionManager }),
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("noop", {}, { id: "dup" }),
				fauxToolCall("noop", {}, { id: "dup" }),
				fauxToolCall("noop", {}, { id: "solo" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	expect(JSON.stringify(harness.sessionManager.getEntries())).not.toMatch(/runtimeItemKey|callUnknown/);
	return harness.sessionManager.getSessionFile() ?? expect.unreachable("no session file");
}

it("RULING-126 (2) #5374 each toolCall part persists its own key; a result keys one open call or says callUnknown", async () => {
	const file = await runTurn();
	const [assistant] = ofRole(linesOf(file), "assistant");
	const keys = partKeys(assistant ?? expect.unreachable("no assistant entry"));
	expect(keys).toHaveLength(3);
	for (const key of keys) expect(key).toMatch(BLOCK_KEY);
	expect(new Set(keys).size).toBe(3);
	expect(keysOf(file).results).toEqual([
		["dup", null, true],
		["dup", null, true],
		["solo", keys[2], null],
	]);
});

it("RULING-127 (i)(ii) #5374 a reload reuses each persisted key, and two incarnations never mint the same key", async () => {
	const file = await runTurn();
	const reopened = SessionManager.open(file, dirname(file));
	const [first] = keysOf(file).parts;
	const [entryId, persisted] = first ?? expect.unreachable("no assistant entry");
	expect(persistedPartKeys(reopened, String(entryId))).toEqual(persisted);
	await runTurn(reopened);
	const all = keysOf(file).parts.flatMap(([, keys]) => keys);
	expect(all).toHaveLength(6);
	expect(new Set(all).size).toBe(6);
});

it("RULING-127 (c) #5374 load, rewrite, reload keeps every key: a migration rewrite and a branch rewrite", async () => {
	const file = await runTurn();
	const before = keysOf(file);
	const lines = linesOf(file);
	writeFileSync(
		file,
		`${lines.map((line, index) => JSON.stringify(index === 0 ? { ...line, version: 2 } : line)).join("\n")}\n`,
	);
	const migrated = SessionManager.open(file, dirname(file));
	expect(linesOf(file)[0]).toMatchObject({ type: "session", version: 3 });
	expect(keysOf(file)).toEqual(before);
	const branched =
		migrated.createBranchedSession(migrated.getLeafId() ?? expect.unreachable("no leaf")) ??
		expect.unreachable("no branched file");
	expect(keysOf(branched)).toEqual(before);
	const reloaded = SessionManager.open(branched, dirname(branched));
	const [[entryId, persisted] = []] = before.parts;
	expect(persistedPartKeys(reloaded, String(entryId))).toEqual(persisted);
});
