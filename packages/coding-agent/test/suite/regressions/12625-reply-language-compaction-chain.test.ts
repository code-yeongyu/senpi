import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../../scripts/vitest-temp.ts";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../../src/core/compaction/index.ts";
import {
	createRequiredCompactionFallback,
	type DeterministicFallbackDiagnostic,
} from "../../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { COMPACTION_SUMMARY_PREFIX, convertToLlm } from "../../../src/core/messages.ts";
import { type CompactionEntry, type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";

// omo#12625 (follow-up to omo#11527): a session that persists its transcript keeps only the latest
// compaction's window resident (senpi#3519), so a compaction whose window holds no turn of the
// user's own lost the reply language. That is every chained deterministic checkpoint of a long,
// tool-heavy turn, and the long English tool output after it then carried no language note either.

const KOREAN_REQUEST = "빌드 로그 확인하고 실패한 테스트 고쳐줘";
const KOREAN_NOTE = "Reply language: Korean (the language of the user's messages)";
const LONG_ENGLISH_OUTPUT = "The build finished and every check reported green on this head. ".repeat(80);

let callCount = 0;

function toolCall(): AssistantMessage {
	callCount++;
	return {
		...assistantMsg(""),
		content: [{ type: "toolCall", id: `call-${callCount}`, name: "read", arguments: { path: "build.log" } }],
		stopReason: "toolUse",
	};
}

function toolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${callCount}`,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function appendToolStep(session: SessionManager, text = LONG_ENGLISH_OUTPUT): void {
	session.appendMessage(toolCall());
	session.appendMessage(toolResult(text));
}

function persistedSession(userText: string): SessionManager {
	const dir = makeTempDir(join(tmpdir(), "s12625-"));
	const session = SessionManager.create(dir, dir);
	session.appendModelChange("anthropic", "claude-opus-5-5");
	session.appendMessage(userMsg(userText));
	appendToolStep(session);
	appendToolStep(session);
	return session;
}

function summarisedCompaction(session: SessionManager): void {
	const branch = session.getBranch();
	const firstKept = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
	session.appendCompaction("## 1. User Requests (Verbatim)\n- Fix the failing test.", firstKept?.id ?? null, 1000);
}

function deterministicCheckpoint(session: SessionManager): CompactionEntry {
	const branch = session.getBranch();
	const preparation = prepareCompaction(branch, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 }, true);
	if (!preparation) throw new Error("expected a compaction preparation");
	const diagnostics: DeterministicFallbackDiagnostic = {};
	const result = createRequiredCompactionFallback(
		preparation,
		200_000,
		"summarization-provider-failure",
		{},
		branch,
		diagnostics,
	);
	if (!result) throw new Error(`expected a deterministic checkpoint: ${JSON.stringify(diagnostics)}`);
	session.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true);
	const checkpoint = session.getBranch().findLast((entry): entry is CompactionEntry => entry.type === "compaction");
	if (!checkpoint) throw new Error("expected the checkpoint on the branch");
	return checkpoint;
}

function texts(messages: Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === "user" && typeof message.content !== "string"
			? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
			: [],
	);
}

function context(session: SessionManager): Message[] {
	return convertToLlm(session.buildSessionContext().messages);
}

function summaryNotes(session: SessionManager): string[] {
	return texts(context(session)).filter(
		(text) => text.startsWith(COMPACTION_SUMMARY_PREFIX) && text.includes(KOREAN_NOTE),
	);
}

function reopened(session: SessionManager): SessionManager {
	return SessionManager.open(session.getSessionFile() ?? "", session.getSessionDir());
}

describe("omo#12625 reply language across compactions of a persisted session", () => {
	it("names the user's language after a summarised compaction that cut every Korean turn", () => {
		// given a persisted Korean session whose compaction window is one English tool step
		const session = persistedSession(KOREAN_REQUEST);

		// when
		summarisedCompaction(session);

		// then no Korean turn is resident, yet the summary names Korean, live and after a reopen
		for (const current of [session, reopened(session)]) {
			expect(texts(context(current)).some((text) => text.includes("빌드"))).toBe(false);
			expect(summaryNotes(current)).toHaveLength(1);
		}
	});

	it("names the user's language after chained deterministic checkpoints of one tool-heavy turn", () => {
		// given a Korean request followed by one long English tool-heavy turn
		const session = persistedSession(KOREAN_REQUEST);

		// when the summary provider fails three times in a row, each checkpoint wrapping the previous one
		const checkpoints = [deterministicCheckpoint(session)];
		for (let round = 0; round < 2; round++) {
			appendToolStep(session);
			appendToolStep(session);
			checkpoints.push(deterministicCheckpoint(session));
		}

		// then every checkpoint records the language and the context names it, live and after a reopen
		expect(checkpoints.map((checkpoint) => checkpoint.userLanguage)).toEqual(["Korean", "Korean", "Korean"]);
		for (const current of [session, reopened(session)]) {
			expect(texts(context(current)).some((text) => text.includes("빌드"))).toBe(false);
			expect(summaryNotes(current)).toHaveLength(1);
		}
	});

	it("notes the user's language after long English tool output that follows a checkpoint", () => {
		// given a deterministic checkpoint that cut the Korean request
		const session = persistedSession(KOREAN_REQUEST);
		deterministicCheckpoint(session);

		// when the turn goes on with long English tool output
		appendToolStep(session);

		// then the note follows that output, right before the next reply
		const last = context(session).at(-1);
		expect(last?.role).toBe("user");
		expect(texts(last ? [last] : [])).toEqual([expect.stringContaining(KOREAN_NOTE)]);
	});

	it("records no language for an English user", () => {
		// given
		const session = persistedSession("check the build log and fix the failing test");

		// when
		const checkpoint = deterministicCheckpoint(session);

		// then
		expect(checkpoint.userLanguage).toBeUndefined();
		expect(texts(context(session)).some((text) => text.includes("Reply language:"))).toBe(false);
	});

	it("ignores a recorded language that is not one of the fixed names", () => {
		// given a session file whose compaction entry was edited to carry arbitrary text
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: userMsg("check the build log"),
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: new Date(0).toISOString(),
				summary: "summary",
				firstKeptEntryId: "c1",
				tokensBefore: 10,
				userLanguage: "my ssn 123-45-6789",
			},
		];

		// when
		const rendered = texts(
			convertToLlm(SessionManager.inMemory(process.cwd(), undefined, entries).buildSessionContext().messages),
		);

		// then
		expect(rendered.some((text) => text.includes("Reply language:"))).toBe(false);
		expect(rendered.some((text) => text.includes("123-45"))).toBe(false);
	});
});
