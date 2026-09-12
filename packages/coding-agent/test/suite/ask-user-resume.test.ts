import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatUserMessage } from "../../src/core/extensions/builtin/ask-user/format.ts";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import type { QuestionRequest, QuestionResponse } from "../../src/core/extensions/builtin/ask-user/schema.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const CALL_ID = "call_ask_user_1";
const TIMEOUT_MS = 30 * 60 * 1000;
const ARGS = {
	questions: [{ header: "Library", question: "Which library?", multiSelect: false }],
	waitForAnswer: true,
};
const CANONICAL_QUESTIONS = [
	{ id: "q1", header: "Library", question: "Which library?", options: [], multiSelect: false },
];
const ANSWER: QuestionResponse = { status: "answered", answers: { q1: { selected: ["A"] } }, unanswered: [] };
const ORPHANED: QuestionResponse = { status: "orphaned-after-restart", answers: {}, unanswered: ["q1"] };
const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type StartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function assistantQuestion(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "ask_user_question", arguments: ARGS }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

async function danglingSession(): Promise<SessionManager> {
	const root = await mkdtemp(join(tmpdir(), "ask-user-resume-"));
	roots.push(root);
	const writer = SessionManager.create(root, join(root, "sessions"));
	writer.appendMessage({ role: "user", content: "pick a library", timestamp: 1 });
	writer.appendMessage(assistantQuestion(CALL_ID));
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected session JSONL fixture");
	return SessionManager.open(file);
}

function resumedIds(sessionManager: SessionManager): string[] {
	const ids: string[] = [];
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== "ask-user:resumed") continue;
		const data = entry.data;
		if (typeof data === "object" && data !== null && "toolCallId" in data && typeof data.toolCallId === "string") {
			ids.push(data.toolCallId);
		}
	}
	return ids;
}

function install(sessionManager: SessionManager) {
	const userMessages: string[] = [];
	const received = Promise.withResolvers<string>();
	const handlers = new Map<string, StartHandler[]>();
	const pi = {
		registerFlag() {},
		registerCommand() {},
		registerTool() {},
		getFlag() {
			return false;
		},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
		on(event: string, handler: StartHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		appendEntry(customType: string, data?: unknown) {
			sessionManager.appendCustomEntry(customType, data);
		},
		sendUserMessage(content: string | Array<{ type: string; text?: string }>) {
			const text =
				typeof content === "string"
					? content
					: content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
			userMessages.push(text);
			received.resolve(text);
		},
	};
	askUserExtension(pi as unknown as ExtensionAPI);
	return { userMessages, received, handlers };
}

function ctx(sessionManager: SessionManager, question?: ExtensionContext["ui"]["question"]): ExtensionContext {
	return {
		sessionManager,
		ui: question ? { question } : {},
		getAskUserSettings: () => ({ enabled: true, timeoutMinutes: 30 }),
		mode: "tui",
		hasUI: question !== undefined,
	} as unknown as ExtensionContext;
}

async function emitStart(
	handlers: Map<string, StartHandler[]>,
	reason: SessionStartEvent["reason"],
	context: ExtensionContext,
) {
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason }, context);
	}
}

describe("ask-user resume", () => {
	it("re-presents a dangling ask_user_question once on resume", async () => {
		const sessionManager = await danglingSession();
		const { userMessages, received, handlers } = install(sessionManager);
		const question = vi.fn(async (request: QuestionRequest) => {
			expect(request.requestId).toBe(CALL_ID);
			expect(request.questions).toEqual(CANONICAL_QUESTIONS);
			return ANSWER;
		});
		await emitStart(handlers, "resume", ctx(sessionManager, question));
		expect(question).toHaveBeenCalledOnce();
		expect(question).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: CALL_ID, timeoutMs: TIMEOUT_MS }),
			expect.objectContaining({ timeout: TIMEOUT_MS }),
		);
		expect(resumedIds(sessionManager)).toEqual([CALL_ID]);
		expect(await received.promise).toBe(formatUserMessage(ANSWER, CALL_ID, CANONICAL_QUESTIONS));
		await emitStart(handlers, "resume", ctx(sessionManager, question));
		expect(question).toHaveBeenCalledOnce();
		expect(userMessages).toHaveLength(1);
	});

	it("delivers one orphaned-after-restart message when resume has no UI", async () => {
		const sessionManager = await danglingSession();
		const { userMessages, handlers } = install(sessionManager);
		await emitStart(handlers, "resume", ctx(sessionManager));
		expect(userMessages).toEqual([formatUserMessage(ORPHANED, CALL_ID, CANONICAL_QUESTIONS)]);
		expect(resumedIds(sessionManager)).toEqual([CALL_ID]);
		await emitStart(handlers, "resume", ctx(sessionManager));
		expect(userMessages).toHaveLength(1);
	});
});
