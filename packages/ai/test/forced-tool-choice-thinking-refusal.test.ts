import { beforeEach, describe, expect, it } from "vitest";
import {
	clearForcedToolChoiceRefusals,
	hasRefusedForcedToolChoice,
	isForcedToolChoiceUnsupportedError,
	sendWithForcedToolChoiceFallback,
} from "../src/utils/tool-choice-fallback.ts";

// senpi#3324: opencode-go's DeepSeek thinking models refuse a forced first-turn tool_choice with this
// wording (request id redacted). No refusal pattern matched it, so the launch died instead of retrying.
const OPENCODE_GO_THINKING_REFUSAL =
	'400: {"type":"invalid_request_error","code":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] Thinking mode does not support this tool_choice (request_id: req_redacted)"}';

class HttpStatusError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const target = {
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go",
	id: "deepseek-v4.1-flash",
};
const FORCED = { type: "function", function: { name: "todo" } } as const;

describe("forced tool_choice refused by a thinking model (#3324)", () => {
	beforeEach(() => clearForcedToolChoiceRefusals());

	it("recognises the refusal only when a choice was forced", () => {
		const refusal = new HttpStatusError(400, OPENCODE_GO_THINKING_REFUSAL);
		expect(isForcedToolChoiceUnsupportedError(refusal, true)).toBe(true);
		expect(isForcedToolChoiceUnsupportedError(refusal, false)).toBe(false);
	});

	it("still rejects unrelated 400s that mention tool_choice support", () => {
		expect(isForcedToolChoiceUnsupportedError(new HttpStatusError(400, "tool_choice is required"), true)).toBe(false);
		expect(
			isForcedToolChoiceUnsupportedError(
				new HttpStatusError(400, "This model does not support this temperature"),
				true,
			),
		).toBe(false);
	});

	it("retries the launch once without tool_choice and does not remember a thinking-dependent refusal", async () => {
		const sent: unknown[] = [];
		const { params, result } = await sendWithForcedToolChoiceFallback({
			target,
			params: { tool_choice: FORCED as unknown, model: target.id },
			acceptsForcedToolChoice: true,
			isForced: (choice) => choice !== undefined && choice !== "auto",
			send: async (request) => {
				sent.push(request.tool_choice);
				if (request.tool_choice !== undefined) throw new HttpStatusError(400, OPENCODE_GO_THINKING_REFUSAL);
				return "ok";
			},
		});
		expect(result).toBe("ok");
		expect(params.tool_choice).toBeUndefined();
		expect(sent).toEqual([FORCED, undefined]);
		expect(hasRefusedForcedToolChoice(target)).toBe(false);
	});
});
