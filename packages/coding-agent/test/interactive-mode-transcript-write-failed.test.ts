import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function makeFakeThis() {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		chatContainer: new Container(),
		ui: {
			requestRender: vi.fn(),
			catchUpScrollback: vi.fn(),
			setScrollbackReplayHold: vi.fn(),
			terminal: { setProgress: vi.fn() },
		},
		settingsManager: { getShowTerminalProgress: () => false },
		turnWorkingTip: { resetForNewTurn: vi.fn() },
		clearPendingTools: vi.fn(),
		clearActiveToolExecutionStatus: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		transcriptWriteNoticeShown: false,
		showWarning: InteractiveMode.prototype.showWarning,
	};
}

type FakeThis = ReturnType<typeof makeFakeThis>;

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: FakeThis,
	event: AgentSessionEvent,
) => Promise<void>;

function renderedChat(fakeThis: FakeThis): string {
	return stripAnsi(fakeThis.chatContainer.render(200).join("\n"));
}

const refusedWrite = (role: "user" | "assistant"): AgentSessionEvent => ({
	type: "transcript_write_failed",
	role,
	errorMessage: "EACCES: permission denied, open '/tmp/session.jsonl'",
});

const NOTICE = "This turn was not saved to the session file (EACCES); the model will not see it after the next prompt.";

describe("interactive mode on a refused transcript write", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows one unsaved-turn notice per run naming the error code", async () => {
		// Given a run whose user message and reply the session file both refused
		const fakeThis = makeFakeThis();

		// When both refusals arrive
		await handleEvent.call(fakeThis, refusedWrite("user"));
		await handleEvent.call(fakeThis, refusedWrite("assistant"));

		// Then the chat carries exactly one notice, with the error code and without the file path
		const chat = renderedChat(fakeThis);
		expect(chat.split(NOTICE)).toHaveLength(2);
		expect(chat).not.toContain("/tmp/session.jsonl");
	});

	test("shows the notice again for a later run that loses its writes", async () => {
		// Given a run that already showed the notice
		const fakeThis = makeFakeThis();
		await handleEvent.call(fakeThis, refusedWrite("user"));

		// When the next run starts and its reply is refused too
		await handleEvent.call(fakeThis, { type: "agent_start" });
		await handleEvent.call(fakeThis, refusedWrite("assistant"));

		// Then that run gets its own notice
		expect(renderedChat(fakeThis).split(NOTICE)).toHaveLength(3);
	});
});
