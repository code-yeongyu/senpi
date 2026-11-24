import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";
import { persistedPartKeys } from "./5374-call-key-fixture-support.ts";

// RULING-127 review condition (senpi#5374): a key is `blk:<messageId>:<contentIndex>` with the producer's message id,
// written once and copied as a string by every path that copies a message: a branch, a fork, a compaction and an
// export. No two toolCall parts of one session file share a key, every copied part keeps its source's key, and a
// compacted session's trimmed mirror never brings a key back into memory.

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

async function keyedRun(sessionManager?: SessionManager): Promise<Harness> {
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
	return harness;
}

const keyedTurn = async (sessionManager?: SessionManager) => (await keyedRun(sessionManager)).sessionManager;

type Part = { type?: string; runtimeItemKey?: string };
type Line = { type?: string; id?: string; message?: { role?: string; content?: Part[] } };

/** Every toolCall part of a session file, `<entryId>:<contentIndex>` to its persisted key. */
function partKeys(file: string): Map<string, string | undefined> {
	const keys = new Map<string, string | undefined>();
	for (const line of readFileSync(file, "utf8").trim().split("\n")) {
		const entry = JSON.parse(line) as Line;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const [index, part] of (entry.message.content ?? []).entries())
			if (part.type === "toolCall") keys.set(`${entry.id}:${index}`, part.runtimeItemKey);
	}
	return keys;
}

const fileOf = (manager: SessionManager) => manager.getSessionFile() ?? expect.unreachable("no session file");

function expectOneKeyPerBlock(file: string): void {
	const keys = [...partKeys(file).values()];
	for (const key of keys) expect(key).toMatch(/^blk:[0-9a-f-]{36}:\d+$/);
	expect(new Set(keys).size, "no two blocks in one session share a key").toBe(keys.length);
}

function expectCopiedFrom(copy: string, source: ReadonlyMap<string, string | undefined>): void {
	const copied = partKeys(copy);
	expect(copied.size).toBeGreaterThan(0);
	for (const [block, key] of copied) if (source.has(block)) expect(key, block).toBe(source.get(block));
}

it("RULING-127 #5374 a branch and a fork copy every block key, and the next turn keys its blocks apart", async () => {
	const source = fileOf(await keyedTurn());
	const before = partKeys(source);
	const opened = SessionManager.open(source, dirname(source));
	const branched =
		opened.createBranchedSession(opened.getLeafId() ?? expect.unreachable("no leaf")) ?? expect.unreachable();
	const forked = fileOf(SessionManager.forkFrom(source, dirname(source), join(dirname(source), "forks")));
	for (const copy of [branched, forked]) {
		expectCopiedFrom(copy, before);
		const next = await keyedTurn(SessionManager.open(copy, dirname(copy)));
		expectCopiedFrom(fileOf(next), before);
		expectOneKeyPerBlock(fileOf(next));
		expect(partKeys(fileOf(next)).size).toBe(6);
	}
});

it("RULING-127 #5374 a compaction keeps every key in the file and none in memory, live and after a reopen", async () => {
	const manager = await keyedTurn();
	const [first] = [...partKeys(fileOf(manager))].map(([block]) => block.split(":")[0]);
	manager.appendCompaction("summary", null, 100);
	await keyedTurn(manager);
	const file = fileOf(manager);
	const before = partKeys(file);
	expectOneKeyPerBlock(file);
	expect(JSON.stringify(manager.getEntries())).not.toMatch(/runtimeItemKey|callUnknown/);
	const reopened = SessionManager.open(file, dirname(file));
	expect(JSON.stringify(reopened.getEntries())).not.toMatch(/runtimeItemKey|callUnknown/);
	expect(JSON.stringify(reopened.getEntry(String(first)))).not.toMatch(/runtimeItemKey/);
	expect(persistedPartKeys(reopened, String(first))).toEqual(
		[0, 1, 2].map((index) => before.get(`${first}:${index}`)),
	);
	const branched =
		reopened.createBranchedSession(reopened.getLeafId() ?? expect.unreachable()) ?? expect.unreachable();
	expectCopiedFrom(branched, before);
	expect(partKeys(branched).size).toBe(6);
});

it("RULING-127 #5374 an exported session keeps every block's key", async () => {
	const harness = await keyedRun();
	const file = fileOf(harness.sessionManager);
	const exported = harness.session.exportToJsonl(join(dirname(file), "export.jsonl"));
	expectCopiedFrom(exported, partKeys(file));
	expect(partKeys(exported).size).toBe(3);
	expectOneKeyPerBlock(exported);
});
