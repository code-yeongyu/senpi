// Refs #1645: display-only answer chips, unchanged model frames and persisted replay.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMouseEvent } from "../../../tui/src/tui.ts";
import { formatUserMessage } from "../../src/core/extensions/builtin/ask-user/format.ts";
import type { QuestionResponse } from "../../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { UserMessageComponent } from "../../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, loadThemeFromPath, setThemeInstance } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const questions = [
	{
		id: "q1",
		header: "Auth",
		question: "Which flow?",
		options: [{ label: "OAuth" }, { label: "API key" }],
		multiSelect: false,
	},
];
const answered: QuestionResponse = { status: "answered", answers: { q1: { selected: ["OAuth"] } }, unanswered: [] };
const frame = "[Answer to question chip-request]\nAuth: OAuth";
const cleanups: Array<() => void> = [];
beforeEach(() =>
	setThemeInstance(
		loadThemeFromPath(join(import.meta.dirname, "../../src/modes/interactive/theme/dark.json"), "truecolor"),
	),
);
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function mouse(type: TuiMouseEvent["type"], height = 1): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 1,
		y: 0,
		screenX: 1,
		screenY: 0,
		width: 80,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}
function plain(component: UserMessageComponent, width = 80) {
	return component.render(width).map((line) => stripAnsi(line).trimEnd());
}
function replayHost(sessionManager: SessionManager) {
	const settingsManager = SettingsManager.inMemory({ showCacheMissNotices: false });
	const host = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: {
			session: { sessionManager, settingsManager, extensionRunner: { getEntryRenderer: () => undefined } },
		},
		chatContainer: new Container(),
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		editor: { addToHistory: vi.fn() },
		outputPad: 1,
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		clearPendingTools: vi.fn(),
		maybeShowAssistantDiagnostics: vi.fn(),
		addContinuityNotice: vi.fn(),
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
	}) as { chatContainer: Container; renderSessionEntries(entries: SessionEntry[]): void };
	return host;
}

describe("ask-user answer chips", () => {
	it("renders one muted compact row for an answered header", () => {
		const component = new UserMessageComponent(frame);
		expect(plain(component)).toEqual(["↳ Auth: OAuth"]);
	});
	it("keeps the shell prompt-zone markers in their original order", () => {
		const chip = new UserMessageComponent(frame).render(80);
		const plainMessage = new UserMessageComponent("Ordinary message").render(80);
		expect(chip).toHaveLength(1);
		expect(chip[0]!.startsWith("\x1b]133;A\x07")).toBe(true);
		expect(chip[0]!.endsWith("\x1b]133;B\x07\x1b]133;C\x07")).toBe(true);
		expect(plainMessage[0]!.startsWith("\x1b]133;A\x07")).toBe(true);
		expect(plainMessage.at(-1)!.startsWith("\x1b]133;B\x07\x1b]133;C\x07")).toBe(true);
	});
	it("handles press without opening, then toggles the full frame on a single click", () => {
		const component = new UserMessageComponent(frame);
		component.render(80);
		expect(dispatchMouseEvent(component, mouse("press"))).toMatchObject({ handled: true });
		expect(plain(component)).toEqual(["↳ Auth: OAuth"]);
		dispatchMouseEvent(component, mouse("click"));
		expect(plain(component).join("\n")).toContain("[Answer to question chip-request]");
		const height = component.render(80).length;
		dispatchMouseEvent(component, mouse("press", height));
		dispatchMouseEvent(component, mouse("click", height));
		expect(plain(component)).toEqual(["↳ Auth: OAuth"]);
	});
	it("does not toggle for a right or repeated click", () => {
		const component = new UserMessageComponent(frame);
		component.render(80);
		dispatchMouseEvent(component, { ...mouse("click"), button: "right" });
		dispatchMouseEvent(component, { ...mouse("click"), clickCount: 2 });
		expect(plain(component)).toEqual(["↳ Auth: OAuth"]);
	});
	it("keeps each answer on one line even in a narrow viewport", () => {
		const component = new UserMessageComponent(
			"[Answer to question chip-request]\nAuth: A deliberately long answer\nDatabase: SQLite",
		);
		const lines = plain(component, 18);
		expect(lines).toHaveLength(2);
		expect(lines.every((line) => line.startsWith("↳ ") && visibleWidth(line) <= 18)).toBe(true);
	});
	it("renders a comment under its retained question header", () => {
		const response: QuestionResponse = {
			status: "comment-submitted",
			answers: {},
			comment: "Use the existing flow",
			unanswered: ["q1"],
		};
		const component = new UserMessageComponent(
			formatUserMessage(response, "chip-request", questions),
			undefined,
			1,
			[],
			["Auth"],
		);
		expect(plain(component)).toEqual(['↳ Auth: "Use the existing flow"']);
	});
	it.each(["timed_out", "cancelled"] as const)(
		"renders %s with the retained header and no invented answer",
		(status) => {
			const response: QuestionResponse = { status, answers: {}, unanswered: ["q1"] };
			const component = new UserMessageComponent(
				formatUserMessage(response, "chip-request", questions),
				undefined,
				1,
				[],
				["Auth"],
			);
			expect(plain(component)).toEqual(["↳ Auth: (no answer)"]);
		},
	);
	it("keeps ordinary user-message rendering byte-identical to the pre-change snapshot", () => {
		expect(new UserMessageComponent("Ordinary **message**", undefined, 1).render(40)).toMatchSnapshot();
	});
	it("keeps the model-facing answer frame byte-identical", () => {
		expect(formatUserMessage(answered, "chip-request", questions)).toBe(frame);
	});
	it("persists only display headers and does not add those entries to model context", async () => {
		const delivery = await createAskUserDelivery();
		cleanups.push(() => delivery.harness.cleanup());
		const controller = new AbortController();
		cleanups.push(() => controller.abort());
		const response = Promise.withResolvers<QuestionResponse>();
		const ctx = delivery.context(() => response.promise);
		const before = delivery.harness.sessionManager.buildSessionContext().messages;
		const execution = delivery.tool.execute(
			"chip-request",
			{ questions, waitForAnswer: false },
			controller.signal,
			undefined,
			ctx,
		);
		const settled = delivery.settled(ctx, "chip-request");
		await execution;
		expect(
			delivery.harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "ask-user:question")
				.map((entry) => (entry.type === "custom" ? entry.data : undefined)),
		).toEqual([{ requestId: "chip-request", headers: ["Auth"] }]);
		expect(delivery.harness.sessionManager.buildSessionContext().messages).toEqual(before);
		response.resolve(answered);
		await settled;
		expect(delivery.deliveries).toEqual([{ content: frame, options: { deliverAs: "followUp" } }]);
	});
	it.each(["answered", "timed_out"] as const)(
		"renders a saved %s frame as a chip through session replay",
		(status) => {
			const root = mkdtempSync(join(tmpdir(), "ask-user-chip-replay-"));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			const writer = SessionManager.create(root, join(root, "sessions"));
			writer.appendCustomEntry("ask-user:question", { requestId: "chip-request", headers: ["Auth"] });
			writer.appendMessage({ role: "user", content: "Initial prompt", timestamp: 1 });
			writer.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Initial reply" }],
				api: "openai-completions",
				provider: "mock",
				model: "mock-model",
				stopReason: "stop",
				timestamp: 2,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const response: QuestionResponse =
				status === "answered" ? answered : { status, answers: {}, unanswered: ["q1"] };
			writer.appendMessage({
				role: "user",
				content: formatUserMessage(response, "chip-request", questions),
				timestamp: 3,
			});
			const path = writer.getSessionFile();
			if (!path) throw new Error("Missing persisted replay file");
			const loaded = SessionManager.open(path);
			const host = replayHost(loaded);
			host.renderSessionEntries(loaded.getBranch());
			const lines = host.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
			expect(lines).toContain(status === "answered" ? "↳ Auth: OAuth" : "↳ Auth: (no answer)");
			expect(lines.some((line) => line.includes("[Answer to question"))).toBe(false);
		},
	);
});
