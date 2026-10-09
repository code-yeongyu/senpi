import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

// Ids are 8 hex chars cut from randomUUID(); a scripted generator makes a collision deterministic.
const { scriptedIds } = vi.hoisted(() => ({ scriptedIds: [] as string[] }));
vi.mock("crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("crypto")>();
	return {
		...actual,
		randomUUID: () => {
			const next = scriptedIds.shift();
			return next === undefined ? actual.randomUUID() : `${next}-0000-4000-8000-000000000000`;
		},
	};
});

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content.map((block) => ("text" in block && typeof block.text === "string" ? block.text : "")).join("")
		: "";
}

describe("reopening a long session after compaction", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `compacted-reopen-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		scriptedIds.length = 0;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function compactedSession() {
		const session = SessionManager.create(dir, dir);
		const trimmedId = session.appendMessage(userMsg("an early request that compaction trims"));
		session.appendMessage(assistantMsg("an early answer"));
		const firstKept = session.appendMessage(userMsg("kept request"));
		session.appendMessage(assistantMsg("kept answer"));
		session.appendCompaction("summary of the early work", firstKept, 1000);
		return { session, trimmedId };
	}

	it("gives a message written after compaction its own id, so the session reopens with everything", () => {
		const { session, trimmedId } = compactedSession();
		// The generator offers the trimmed entry's id first, as a random collision would.
		scriptedIds.push(trimmedId);
		const laterId = session.appendMessage(userMsg("a request after compaction"));
		session.appendMessage(assistantMsg("its answer"));

		expect(laterId).not.toBe(trimmedId);
		const reopened = SessionManager.open(session.getSessionFile()!, dir);
		const branchTexts = reopened
			.getBranch()
			.flatMap((entry) => (entry.type === "message" ? [textOf(entry.message)] : []));
		expect(branchTexts[0]).toBe("an early request that compaction trims");
		expect(branchTexts.at(-1)).toBe("its answer");
		const contextTexts = reopened.buildSessionContext().messages.map(textOf);
		expect(contextTexts).toContain("a request after compaction");
		expect(contextTexts).toContain("its answer");
	});

	it("still opens a file that already reuses an id, with the latest conversation in context", () => {
		const { session, trimmedId } = compactedSession();
		const file = session.getSessionFile()!;
		const lines = readFileSync(file, "utf8").trim().split("\n");
		const leaf = JSON.parse(lines.at(-1)!) as { id: string };
		// A file written before the fix: a later entry reused the trimmed entry's id.
		const reused = {
			...JSON.parse(lines[1]!),
			id: trimmedId,
			parentId: leaf.id,
			timestamp: new Date().toISOString(),
		};
		reused.message = { ...userMsg("a request whose id was reused"), timestamp: Date.now() };
		appendFileSync(file, `${JSON.stringify(reused)}\n`);
		const answer = {
			...JSON.parse(lines[2]!),
			id: "abcdef01",
			parentId: trimmedId,
			timestamp: new Date().toISOString(),
		};
		answer.message = { ...assistantMsg("the answer after it"), timestamp: Date.now() };
		appendFileSync(file, `${JSON.stringify(answer)}\n`);

		const reopened = SessionManager.open(file, dir);
		const contextTexts = reopened.buildSessionContext().messages.map(textOf);
		expect(contextTexts.at(-1)).toBe("the answer after it");
		expect(reopened.getBranch().at(-1)?.id).toBe("abcdef01");
	});

	it("opens the session tree of a file with duplicated lines, listing each entry once", () => {
		const session = SessionManager.create(dir, dir);
		for (let turn = 0; turn < 40; turn++) {
			session.appendMessage(userMsg(`request ${turn}`));
			session.appendMessage(assistantMsg(`answer ${turn}`));
		}
		const file = session.getSessionFile()!;
		const lines = readFileSync(file, "utf8").trim().split("\n");
		// Adjacent duplicated pairs along the chain, the shape reported in #1247.
		const duplicated = lines.flatMap((line, index) => (index > 0 && index % 3 === 0 ? [line, line] : [line]));
		writeFileSync(file, `${duplicated.join("\n")}\n`);

		const reopened = SessionManager.open(file, dir);
		const roots = reopened.getTree();
		const seen: string[] = [];
		const stack = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			seen.push(node.entry.id);
			stack.push(...node.children);
		}
		expect(new Set(seen).size).toBe(80);
		expect(seen).toHaveLength(80);
		expect(reopened.buildSessionContext().messages.map(textOf).at(-1)).toBe("answer 39");
	});
});
