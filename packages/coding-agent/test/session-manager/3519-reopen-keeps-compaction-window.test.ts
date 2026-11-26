import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadEntriesFromFile,
	SessionManager,
	type SessionTreeNode,
	setSessionEntryLoaderForTesting,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const LARGE_TEXT = "x".repeat(256 * 1024);

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content.map((block) => ("text" in block && typeof block.text === "string" ? block.text : "")).join("")
		: "";
}

function treeIds(roots: SessionTreeNode[]): string[] {
	const ids: string[] = [];
	const stack = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		ids.push(node.entry.id);
		stack.push(...node.children);
	}
	return ids.sort();
}

describe("reopening a compacted session keeps only the latest compaction window resident (senpi#3519)", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `reopen-window-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function compactedSession() {
		const session = SessionManager.create(dir, dir);
		session.appendModelChange("anthropic", "test");
		const early = session.appendMessage(userMsg(`early ${LARGE_TEXT}`));
		session.appendMessage(assistantMsg(`early answer ${LARGE_TEXT}`));
		session.appendLabelChange(early, "start");
		session.appendSessionInfo("long session");
		const firstKept = session.appendMessage(userMsg("kept request"));
		session.appendMessage(assistantMsg("kept answer"));
		session.appendCompaction("summary of the early work", firstKept, 1000);
		session.appendMessage(userMsg("after compaction"));
		const tip = session.appendMessage(assistantMsg("answer after compaction"));
		return { session, early, tip, file: session.getSessionFile()! };
	}

	it("holds none of the pre-window text after a reopen", () => {
		const { file } = compactedSession();

		const reopened = SessionManager.open(file, dir);

		expect(reopened.getResidentStore().size().approxBytes).toBe(0);
	});

	it("serves every reader the same session it served before the reopen", () => {
		const { session, early, file } = compactedSession();
		const live = {
			context: session.buildSessionContext().messages.map(textOf),
			ids: session.getEntries().map((entry) => entry.id),
			count: session.getEntryCount(),
			usage: { ...session.getUsageTotals() },
			tree: treeIds(session.getTree()),
		};
		const bytes = readFileSync(file, "utf8");

		const reopened = SessionManager.open(file, dir);

		expect(reopened.buildSessionContext().messages.map(textOf)).toEqual(live.context);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual(live.ids);
		expect(reopened.getEntryCount()).toBe(live.count);
		expect(reopened.getUsageTotals()).toEqual(live.usage);
		expect(treeIds(reopened.getTree())).toEqual(live.tree);
		expect(reopened.getLabel(early)).toBe("start");
		expect(reopened.getSessionName()).toBe("long session");
		expect(reopened.countCompactions()).toBe(1);
		expect(textOf((reopened.getEntry(early) as { message: AgentMessage }).message)).toBe(`early ${LARGE_TEXT}`);
		expect(readFileSync(file, "utf8")).toBe(bytes);
	});

	it("answers the open's full-history reads from the load itself, and lets them go with the views", () => {
		const { file } = compactedSession();
		let reads = 0;
		const restore = setSessionEntryLoaderForTesting((path) => {
			reads++;
			return loadEntriesFromFile(path);
		});
		try {
			const reopened = SessionManager.open(file, dir);
			const count = reopened.getEntries().length;
			expect(reads).toBe(0);

			reopened.dropMaterializedCaches();

			expect(reopened.holdsMaterializedHistory()).toBe(false);
			expect(reopened.getEntries()).toHaveLength(count);
			expect(reads).toBe(1);
		} finally {
			restore();
		}
	});

	it("labels a trimmed entry from the history the session already parsed, not a second parse", () => {
		const { early, file } = compactedSession();
		let reads = 0;
		const restore = setSessionEntryLoaderForTesting((path) => {
			reads++;
			return loadEntriesFromFile(path);
		});
		try {
			const reopened = SessionManager.open(file, dir);
			reopened.dropMaterializedCaches();

			reopened.appendLabelChange(early, "again");
			const labels = reopened.getEntries().filter((entry) => entry.type === "label").length;

			expect(labels).toBe(2);
			expect(reopened.getLabel(early)).toBe("again");
			expect(reads).toBe(1);
		} finally {
			restore();
		}
	});

	it("keeps appending to the file it reopened, and the next reopen sees the new turn", () => {
		const { file } = compactedSession();
		const reopened = SessionManager.open(file, dir);
		const added = reopened.appendMessage(userMsg("a turn after the reopen"));

		const again = SessionManager.open(file, dir);

		expect(again.getLeafId()).toBe(added);
		expect(again.buildSessionContext().messages.map(textOf).at(-1)).toBe("a turn after the reopen");
	});

	it("branches back to an entry before the window", () => {
		const { early, file } = compactedSession();
		const reopened = SessionManager.open(file, dir);

		reopened.branch(early);

		expect(reopened.buildSessionContext().messages.map(textOf)).toEqual([`early ${LARGE_TEXT}`]);
	});

	it("keeps the whole file resident when a branch forks from before the window", () => {
		const { early, tip, file } = compactedSession();
		const writer = SessionManager.open(file, dir);
		writer.branch(early);
		writer.appendMessage(assistantMsg("a branch from before the window"));
		writer.branch(tip);
		writer.appendMessage(userMsg("back on the compacted branch"));

		const reopened = SessionManager.open(file, dir);

		expect(reopened.getResidentStore().size().approxBytes).toBeGreaterThan(0);
		expect(reopened.buildSessionContext().messages.map(textOf).at(-1)).toBe("back on the compacted branch");
	});
});

describe("a live compaction keeps the session's usage totals (senpi#3519)", () => {
	it("still counts the usage of the turns the compaction trimmed", () => {
		const dir = join(tmpdir(), `live-usage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		try {
			const session = SessionManager.create(dir, dir);
			session.appendMessage(userMsg("early"));
			session.appendMessage(assistantMsg("early answer"));
			const firstKept = session.appendMessage(userMsg("kept"));
			session.appendMessage(assistantMsg("kept answer"));
			const before = { ...session.getUsageTotals() };

			session.appendCompaction("summary", firstKept, 100);

			expect(session.getUsageTotals()).toEqual(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
