import { expect, it, vi } from "vitest";
import { settleExtensionUiResponse } from "./extension-ui-response.ts";
import { SessionExtensionUiRequests } from "./session-extension-ui-requests.ts";
import { UiAnswerLedger } from "./ui-answer-ledger.ts";

// #4266: retries are receipts, not a second application of user input.
it("replays the same answerId, rejects a competing answer, and identifies unknown requests", () => {
	const dialogs = new SessionExtensionUiRequests();
	const resolve = vi.fn();
	dialogs.set("dialog", { resolve, reject: () => {} });
	const ledger = new UiAnswerLedger();
	const targets = { dialogs, questions: { respond: () => false }, routed: true, ledger };
	const frame = {
		type: "extension_ui_response",
		id: "frame",
		uiRequestId: "dialog",
		answerId: "answer",
		confirmed: true,
	} as const;
	expect(settleExtensionUiResponse(frame, targets)).toMatchObject({ success: true, disposition: "applied" });
	expect(settleExtensionUiResponse({ ...frame, id: "retry" }, targets)).toMatchObject({
		id: "retry",
		success: true,
		disposition: "replay",
	});
	expect(settleExtensionUiResponse({ ...frame, answerId: "other" }, targets)).toMatchObject({
		success: false,
		disposition: "already_answered",
	});
	expect(settleExtensionUiResponse({ ...frame, uiRequestId: "never-seen" }, targets)).toMatchObject({
		success: false,
		disposition: "unknown",
		error: "unknown_extension_ui_request",
	});
	expect(resolve).toHaveBeenCalledTimes(1);
	expect(ledger.snapshot()).toEqual([{ uiRequestId: "dialog", answerId: "answer" }]);
});

it("bounds receipts at 1024 in FIFO order and projects only the latest 64", () => {
	const ledger = new UiAnswerLedger();
	for (let i = 0; i < 1025; i++) ledger.record(String(i), "answer");
	expect(ledger.lookup("0", "answer")).toBeUndefined();
	expect(ledger.lookup("1", "answer")).toBe("replay");
	expect(ledger.snapshot()).toHaveLength(64);
	expect(ledger.snapshot()[0]).toEqual({ uiRequestId: "961", answerId: "answer" });
	ledger.lookup("1", "answer");
	ledger.record("1025", "answer");
	expect(ledger.lookup("1", "answer")).toBeUndefined();
});

it.each(["", "a".repeat(257), 1])("rejects invalid answerId %s before settling, without a disposition", (answerId) => {
	const resolve = vi.fn();
	const dialogs = new SessionExtensionUiRequests();
	dialogs.set("dialog", { resolve, reject: () => {} });
	const frame = JSON.parse(JSON.stringify({ type: "extension_ui_response", id: "dialog", answerId, confirmed: true }));
	const reply = settleExtensionUiResponse(frame, {
		dialogs,
		questions: { respond: () => false },
		routed: true,
		ledger: new UiAnswerLedger(),
	});
	expect(reply).toMatchObject({ success: false, error: "invalid_answer_id" });
	// A malformed answer settles nothing, so it claims no outcome for the request.
	expect(reply).not.toHaveProperty("disposition");
	expect(resolve).not.toHaveBeenCalled();
});

// #4266: the unrouted classic connection still ignores an unnamed stray answer; a named one asks for a receipt.
it("answers a named answer to an unknown request on an unrouted connection", () => {
	const targets = {
		dialogs: new SessionExtensionUiRequests(),
		questions: { respond: () => false },
		routed: false,
		ledger: new UiAnswerLedger(),
	};
	const frame = { type: "extension_ui_response", id: "frame", uiRequestId: "absent", confirmed: true } as const;
	expect(settleExtensionUiResponse(frame, targets)).toBeUndefined();
	expect(settleExtensionUiResponse({ ...frame, answerId: "answer" }, targets)).toEqual({
		id: "frame",
		type: "response",
		command: "extension_ui_response",
		success: false,
		error: "unknown_extension_ui_request",
		disposition: "unknown",
	});
});
