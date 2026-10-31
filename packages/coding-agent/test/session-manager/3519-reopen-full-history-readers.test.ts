import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
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

function messageTexts(entries: readonly { type: string; message?: AgentMessage }[]): string[] {
	return entries.flatMap((entry) => (entry.type === "message" && entry.message ? [textOf(entry.message)] : []));
}

describe("readers that need the whole history after a reopen trims the mirror (senpi#3519 review)", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `reopen-full-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function compactedSession() {
		const session = SessionManager.create(dir, dir);
		const early = session.appendMessage(userMsg(`early ${LARGE_TEXT}`));
		session.appendMessage(assistantMsg("early answer"));
		const firstKept = session.appendMessage(userMsg("kept"));
		session.appendMessage(assistantMsg("kept answer"));
		session.appendCompaction("summary", firstKept, 1000);
		session.appendMessage(userMsg("after"));
		const tip = session.appendMessage(assistantMsg("after answer"));
		return { early, tip, file: session.getSessionFile()! };
	}

	it("forks a reopened session from a recent entry with its whole history", () => {
		const { tip, file } = compactedSession();
		const reopened = SessionManager.open(file, dir);

		const forked = reopened.createBranchedSession(tip);

		const lines = readFileSync(forked!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(messageTexts(lines)).toEqual([
			`early ${LARGE_TEXT}`,
			"early answer",
			"kept",
			"kept answer",
			"after",
			"after answer",
		]);
	});

	it("labels an entry from before the window and keeps the label across a reopen", () => {
		const { early, file } = compactedSession();
		const reopened = SessionManager.open(file, dir);

		reopened.appendLabelChange(early, "start");

		expect(reopened.getLabel(early)).toBe("start");
		expect(SessionManager.open(file, dir).getLabel(early)).toBe("start");
	});

	it("answers getFullBranch with the whole path while getBranch keeps the window", () => {
		const { file } = compactedSession();
		const reopened = SessionManager.open(file, dir);

		expect(messageTexts(reopened.getFullBranch())).toEqual([
			`early ${LARGE_TEXT}`,
			"early answer",
			"kept",
			"kept answer",
			"after",
			"after answer",
		]);
		expect(messageTexts(reopened.getBranch())).toEqual(["kept", "kept answer", "after", "after answer"]);
	});

	it("summarizes a branch back to an entry before the window", () => {
		const { early, file } = compactedSession();
		const reopened = SessionManager.open(file, dir);

		reopened.branchWithSummary(early, "abandoned path");

		expect(reopened.getBranch().map((entry) => entry.type)).toEqual(["message", "branch_summary"]);
	});

	it("keeps a file with duplicated entry ids fully resident", () => {
		const { file } = compactedSession();
		const lines = readFileSync(file, "utf8").trim().split("\n");
		writeFileSync(file, `${[...lines.slice(0, 2), lines[1], ...lines.slice(2)].join("\n")}\n`);

		const reopened = SessionManager.open(file, dir);

		expect(reopened.getResidentStore().size().approxBytes).toBeGreaterThan(0);
		expect(
			messageTexts(reopened.buildSessionContext().messages.map((message) => ({ type: "message", message }))),
		).toContain("after answer");
	});

	it("keeps the file resident when the compaction's first kept entry is off the leaf's branch", () => {
		const session = SessionManager.create(dir, dir);
		session.appendMessage(userMsg(`early ${LARGE_TEXT}`));
		const fork = session.appendMessage(assistantMsg("early answer"));
		// A sibling of the kept branch, so every entry after it hangs off the same parent and only the
		// off-branch check can refuse the trim.
		const offBranch = session.appendMessage(userMsg("a branch that is abandoned"));
		session.branch(fork);
		session.appendMessage(userMsg("the kept branch"));
		session.appendCompaction("summary", offBranch, 1000);
		session.appendMessage(userMsg("after"));

		const reopened = SessionManager.open(session.getSessionFile()!, dir);

		expect(reopened.getResidentStore().size().approxBytes).toBeGreaterThan(0);
	});
});
