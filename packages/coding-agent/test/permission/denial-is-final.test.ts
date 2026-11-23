import { describe, expect, it } from "vitest";
import type { PermissionEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { handleNoUI } from "../../src/core/extensions/builtin/permission-system/non-interactive.ts";
import { PendingRequests } from "../../src/core/extensions/builtin/permission-system/pending-requests.ts";
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
		["no UI to ask", handleNoUI(request, { emitEvent: () => {} }).refusal ?? ""],
		["no UI to ask under auto", handleNoUI(request, { emitEvent: () => {}, presetBound: true }).refusal ?? ""],
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

// senpi#4401: no user was asked, so the model must receive the system's refusal once, not framed as user feedback.
it("delivers the no-UI refusal as a system refusal, stated once", async () => {
	const pending = new PendingRequests({
		emitter: { emitReplied: () => {} } as unknown as PermissionEventEmitter,
		approve: () => {},
		decide: () => "ask",
	});
	const asked = pending.register(request, {} as never);
	const reply = handleNoUI(request, { emitEvent: () => {} });
	pending.reply(reply);
	const delivered = await asked.then(
		() => "",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	expect(delivered).toBe(reply.refusal);
	expect(delivered).not.toContain("The user rejected");
	expect(delivered.split(NO_OTHER_ROUTE)).toHaveLength(2);
});
