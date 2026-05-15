import { describe, expect, it, vi } from "vitest";
import {
	emitBuiltinSystemMessageFailure,
	SENPI_CONVERSATION_EVENT,
	SENPI_SYSTEM_PREFIX,
	sendBuiltinCustomMessage,
	sendBuiltinUserMessage,
} from "../../src/core/extensions/builtin/system-messages.js";
import { SENPI_SYSTEM_PREFIX as TODO_SYSTEM_PREFIX } from "../../src/core/extensions/builtin/todotools/system-messages.js";

function createMockPi() {
	return {
		sendUserMessage: vi.fn(),
		sendMessage: vi.fn(),
		events: {
			emit: vi.fn(),
		},
	};
}

describe("senpi conversation helpers", () => {
	it("uses the senpi marker for injected system prefixes", () => {
		expect(SENPI_SYSTEM_PREFIX).toBe("[system:senpi]");
		expect(TODO_SYSTEM_PREFIX).toBe("[system:senpi]");
	});

	it("emits a unified injected event and prefixes builtin user messages", () => {
		const pi = createMockPi();

		sendBuiltinUserMessage(pi as never, "todotools.continuation", "Continue the task", {
			sessionId: "session-1",
		});

		expect(pi.sendUserMessage).toHaveBeenCalledWith(`${SENPI_SYSTEM_PREFIX}\nContinue the task`);
		expect(pi.events.emit).toHaveBeenCalledWith(
			SENPI_CONVERSATION_EVENT,
			expect.objectContaining({
				version: 1,
				source: "builtin",
				action: "injected",
				route: "todotools.continuation",
				sessionId: "session-1",
				conversation: expect.objectContaining({
					kind: "user_message",
					prefix: SENPI_SYSTEM_PREFIX,
				}),
				text: `${SENPI_SYSTEM_PREFIX}\nContinue the task`,
			}),
		);
	});

	it("emits a unified injected event and prefixes builtin custom messages", () => {
		const pi = createMockPi();

		sendBuiltinCustomMessage(
			pi as never,
			"todotools.continuation",
			{
				customType: "senpi.test",
				display: true,
				content: [{ type: "text", text: "<system-reminder>\nDone\n</system-reminder>" }],
			},
			{ triggerTurn: true, deliverAs: "followUp", sessionId: "session-2" },
		);

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "senpi.test",
				content: [
					expect.objectContaining({
						type: "text",
						text: `${SENPI_SYSTEM_PREFIX}\n<system-reminder>\nDone\n</system-reminder>`,
					}),
				],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(pi.events.emit).toHaveBeenCalledWith(
			SENPI_CONVERSATION_EVENT,
			expect.objectContaining({
				version: 1,
				source: "builtin",
				action: "injected",
				route: "todotools.continuation",
				sessionId: "session-2",
				conversation: expect.objectContaining({
					kind: "custom_message",
					customType: "senpi.test",
					prefix: SENPI_SYSTEM_PREFIX,
					triggerTurn: true,
					deliverAs: "followUp",
				}),
			}),
		);
	});

	it("emits a unified failed event for senpi conversation injection failures", () => {
		const pi = createMockPi();

		emitBuiltinSystemMessageFailure(pi as never, {
			route: "todotools.continuation",
			sessionId: "session-3",
			kind: "user_message",
			content: "Continue after failure",
			errorMessage: "dispatch failed",
		});

		expect(pi.events.emit).toHaveBeenCalledWith(
			SENPI_CONVERSATION_EVENT,
			expect.objectContaining({
				version: 1,
				source: "builtin",
				action: "failed",
				route: "todotools.continuation",
				sessionId: "session-3",
				conversation: expect.objectContaining({
					kind: "user_message",
					prefix: SENPI_SYSTEM_PREFIX,
				}),
				text: `${SENPI_SYSTEM_PREFIX}\nContinue after failure`,
				errorMessage: "dispatch failed",
			}),
		);
	});
});
