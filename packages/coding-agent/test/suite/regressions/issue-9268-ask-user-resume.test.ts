import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, JsonObject, Usage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import askUserExtension from "../../../src/core/extensions/builtin/ask-user/index.ts";
import { ASK_USER_SETTLEMENT_ENTRY } from "../../../src/core/extensions/builtin/ask-user/notify.ts";
import { getPendingQuestions } from "../../../src/core/extensions/builtin/ask-user/registry.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { ASK_USER_WIDGET_KEY } from "../../../src/modes/interactive/components/ask-user-async-widget.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createFakeInteractiveMode } from "../helpers/ask-user-async-fake-mode.ts";

const CALL_ID = "call_ask_user_9268";
const ALT_A = "\x1ba";
const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const roots: string[] = [];

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function assistantCall(args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: CALL_ID, name: "ask_user_question", arguments: args as JsonObject }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

async function danglingSession(args: Record<string, unknown>): Promise<SessionManager> {
	const root = await mkdtemp(join(tmpdir(), "issue-9268-"));
	roots.push(root);
	const writer = SessionManager.create(root, join(root, "sessions"));
	writer.appendMessage({ role: "user", content: "ask me", timestamp: 1 });
	writer.appendMessage(assistantCall(args));
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected session file");
	return SessionManager.open(file);
}

function install(sessionManager: SessionManager) {
	const handlers: Array<(event: SessionStartEvent, ctx: ExtensionContext) => unknown> = [];
	const userMessages: string[] = [];
	const pi = {
		events: createEventBus(),
		registerFlag() {},
		registerCommand() {},
		registerTool() {},
		getFlag: () => false,
		getActiveTools: () => [],
		setActiveTools() {},
		on(event: string, handler: (event: SessionStartEvent, ctx: ExtensionContext) => unknown) {
			if (event === "session_start") handlers.push(handler);
		},
		appendEntry(customType: string, data?: unknown) {
			sessionManager.appendCustomEntry(customType, data);
		},
		sendUserMessage(content: string | Array<{ type: string; text?: string }>) {
			userMessages.push(
				typeof content === "string"
					? content
					: content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""),
			);
		},
	};
	askUserExtension(pi as unknown as ExtensionAPI);
	return { handlers, userMessages };
}

function settlementStatuses(sessionManager: SessionManager): unknown[] {
	const statuses: unknown[] = [];
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ASK_USER_SETTLEMENT_ENTRY) continue;
		const data = entry.data;
		statuses.push(typeof data === "object" && data !== null && "status" in data ? data.status : undefined);
	}
	return statuses;
}

describe("omo #9268 malformed ask-user resume", () => {
	it.each([
		["unparseable", {}],
		["empty", { questions: [], waitForAnswer: false }],
	])("settles %s arguments without rendering pending UI", async (_kind, args) => {
		const sessionManager = await danglingSession(args);
		const fake = createFakeInteractiveMode();
		const { handlers, userMessages } = install(sessionManager);
		const context = {
			sessionManager,
			ui: fake.createExtensionUIContext(),
			isIdle: () => true,
			getAskUserSettings: () => ({ enabled: true, timeoutMinutes: 30 }),
			mode: "tui",
			hasUI: true,
		} as unknown as ExtensionContext;

		for (const handler of handlers) await handler({ type: "session_start", reason: "resume" }, context);

		expect(() => fake.pressEditorKey(ALT_A)).not.toThrow();
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();
		expect(getPendingQuestions(sessionManager.getSessionId())).toEqual([]);
		expect(settlementStatuses(sessionManager)).toEqual(["orphaned-after-restart"]);
		expect(userMessages).toEqual([
			`[Answer to question ${CALL_ID}]\nThe pending question could not be resumed after a restart; continue on best judgment.`,
		]);
	});
});
