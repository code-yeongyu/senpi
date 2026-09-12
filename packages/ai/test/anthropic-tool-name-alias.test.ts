import { describe, expect, it } from "vitest";
import { fromClaudeCodeName, toClaudeCodeName } from "../src/api/anthropic-messages.ts";
import type { Tool } from "../src/types.ts";

describe("Anthropic Claude Code tool-name aliases", () => {
	const askUserTool: Tool = {
		name: "ask_user_question",
		description: "Ask the user a question",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	};

	it("maps ask_user_question to AskUserQuestion on the wire", () => {
		expect(toClaudeCodeName("ask_user_question")).toBe("AskUserQuestion");
	});

	it("maps AskUserQuestion back when the tool is registered", () => {
		expect(fromClaudeCodeName("AskUserQuestion", [askUserTool])).toBe("ask_user_question");
	});

	it("leaves AskUserQuestion unchanged when it is not registered", () => {
		expect(fromClaudeCodeName("AskUserQuestion", [])).toBe("AskUserQuestion");
	});

	it("keeps the existing read alias", () => {
		expect(toClaudeCodeName("read")).toBe("Read");
		expect(fromClaudeCodeName("Read", [{ ...askUserTool, name: "read" }])).toBe("read");
	});
});
