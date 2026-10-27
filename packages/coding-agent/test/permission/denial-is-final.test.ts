import { describe, expect, it } from "vitest";
import { handleNoUI } from "../../src/core/extensions/builtin/permission-system/non-interactive.ts";
import {
	CorrectedError,
	DeniedError,
	NO_OTHER_ROUTE,
	RejectedError,
	type Request,
} from "../../src/core/extensions/builtin/permission-system/types.ts";

const request: Request = {
	id: "request-1",
	sessionID: "session-1",
	permission: "bash",
	patterns: ["git push"],
	always: ["git push *"],
	metadata: {},
};

describe("every refusal tells the model not to reach the refused result another way", () => {
	it.each([
		["a user's denial", new RejectedError().message],
		["a denial with feedback", new CorrectedError("not now").message],
		["a permission rule", new DeniedError(["git push"]).message],
		["no UI to ask", handleNoUI(request, { emitEvent: () => {} }).message ?? ""],
		["no UI to ask under auto", handleNoUI(request, { emitEvent: () => {}, presetBound: true }).message ?? ""],
	])("%s", (_path, message) => {
		expect(message).toContain(NO_OTHER_ROUTE);
	});

	it("keeps the first sentence clients match as a prefix", () => {
		expect(
			new RejectedError().message.startsWith("The user rejected permission to use this specific tool call."),
		).toBe(true);
		expect(
			new DeniedError(["x"]).message.startsWith(
				"The user has specified a rule which prevents you from using this specific tool call.",
			),
		).toBe(true);
		expect(
			new CorrectedError("f").message.startsWith(
				"The user rejected permission to use this specific tool call with the following feedback: f",
			),
		).toBe(true);
	});
});
