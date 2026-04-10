import { describe, expect, it, vi } from "vitest";
import {
	emitBuiltinSystemMessageFailure,
	SANEPI_CONVERSATION_EVENT,
	SANEPI_SYSTEM_PREFIX,
	sendBuiltinCustomMessage,
	sendBuiltinUserMessage,
} from "../../src/core/extensions/builtin/system-messages.js";

function createMockPi() {
	return {
		sendUserMessage: vi.fn(),
		sendMessage: vi.fn(),
		events: {
			emit: vi.fn(),
		},
	};
}

describe("sanepi conversation helpers", () => {
	it("emits a unified injected event and prefixes builtin user messages", () => {
		const pi = createMockPi();

		sendBuiltinUserMessage(pi as never, "todotools.continuation", "Continue the task", {
			sessionId: "session-1",
		});

		expect(pi.sendUserMessage).toHaveBeenCalledWith(`${SANEPI_SYSTEM_PREFIX}\nContinue the task`);
		expect(pi.events.emit).toHaveBeenCalledWith(
			SANEPI_CONVERSATION_EVENT,
			expect.objectContaining({
				version: 1,
				source: "builtin",
				action: "injected",
				route: "todotools.continuation",
				sessionId: "session-1",
				conversation: expect.objectContaining({
					kind: "user_message",
					prefix: SANEPI_SYSTEM_PREFIX,
				}),
				text: `${SANEPI_SYSTEM_PREFIX}\nContinue the task`,
			}),
		);
	});

	it("emits a unified injected event and prefixes builtin custom messages", () => {
		const pi = createMockPi();

		sendBuiltinCustomMessage(
			pi as never,
			"background-task.notification",
			{
				customType: "background-task.complete",
				display: true,
				content: [{ type: "text", text: "<system-reminder>\nDone\n</system-reminder>" }],
			},
			{ triggerTurn: true, deliverAs: "followUp", sessionId: "session-2" },
		);

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "background-task.complete",
				content: [
					expect.objectContaining({
						type: "text",
						text: `${SANEPI_SYSTEM_PREFIX}\n<system-reminder>\nDone\n</system-reminder>`,
					}),
				],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(pi.events.emit).toHaveBeenCalledWith(
			SANEPI_CONVERSATION_EVENT,
			expect.objectContaining({
				version: 1,
				source: "builtin",
				action: "injected",
				route: "background-task.notification",
				sessionId: "session-2",
				conversation: expect.objectContaining({
					kind: "custom_message",
					customType: "background-task.complete",
					prefix: SANEPI_SYSTEM_PREFIX,
					triggerTurn: true,
					deliverAs: "followUp",
				}),
			}),
		);
	});

	it("emits a unified failed event for sanepi conversation injection failures", () => {
		const pi = createMockPi();

		emitBuiltinSystemMessageFailure(pi as never, {
			route: "todotools.continuation",
			sessionId: "session-3",
			kind: "user_message",
			content: "Continue after failure",
			errorMessage: "dispatch failed",
		});

		expect(pi.events.emit).toHaveBeenCalledWith(
			SANEPI_CONVERSATION_EVENT,
			expect.objectContaining({
				version: 1,
				source: "builtin",
				action: "failed",
				route: "todotools.continuation",
				sessionId: "session-3",
				conversation: expect.objectContaining({
					kind: "user_message",
					prefix: SANEPI_SYSTEM_PREFIX,
				}),
				text: `${SANEPI_SYSTEM_PREFIX}\nContinue after failure`,
				errorMessage: "dispatch failed",
			}),
		);
	});
});
