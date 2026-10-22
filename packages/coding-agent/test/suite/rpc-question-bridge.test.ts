import { afterEach, expect, it, vi } from "vitest";
import { formatModelAnswer } from "../../src/core/extensions/builtin/ask-user/format.ts";
import { ConnectionQuestionBridge, degradeQuestion } from "../../src/modes/rpc/connection-question-bridge.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

const request = {
	requestId: "tool-1",
	waitForAnswer: true,
	timeoutMs: 1000,
	questions: ["q1", "q2"].map((id) => ({
		id,
		header: id,
		question: id,
		options: [{ label: "A" }, { label: "B" }],
		multiSelect: false,
	})),
};
afterEach(() => vi.useRealTimers());
it("degrades into sequential select/input dialogs, one per question and nothing after them", async () => {
	const select = vi.fn().mockResolvedValueOnce("A").mockResolvedValueOnce("Other (type an answer)");
	const input = vi.fn().mockResolvedValueOnce("custom");
	expect(await degradeQuestion({ select, input }, request)).toEqual({
		status: "answered",
		resolvedBy: "rpc_connection",
		answers: { q1: { selected: ["A"] }, q2: { selected: [], text: "custom" } },
		comment: undefined,
		unanswered: [],
	});
	expect(select).toHaveBeenCalledTimes(2);
	expect(input).toHaveBeenCalledTimes(1);
	expect(input.mock.calls[0][0]).toBe("q2");
	expect(select.mock.calls[0][1]).toEqual(["A", "B", "Other (type an answer)"]);
});
// sisyphuslabs/omo-desktop-app#4042: a client without the `question` capability renders every
// dialog as its own blocking card, so a trailing optional-comment prompt reads as a new question.
it("settles a degraded question from its picks alone, raising no optional-comment prompt", async () => {
	const select = vi.fn().mockResolvedValueOnce("A").mockResolvedValueOnce("B");
	const input = vi.fn().mockResolvedValue("");
	expect(await degradeQuestion({ select, input }, request)).toEqual({
		status: "answered",
		resolvedBy: "rpc_connection",
		answers: { q1: { selected: ["A"] }, q2: { selected: ["B"] } },
		comment: undefined,
		unanswered: [],
	});
	expect(input).not.toHaveBeenCalled();
});
// The desktop answers an input card with its one option label, "Answer" (#4042): that label must never
// become the user's comment, so the model never reads "The user responded: Answer".
it("never turns an input card's 'Answer' label into the comment the model reads", async () => {
	const select = vi.fn().mockResolvedValueOnce("A").mockResolvedValueOnce("B");
	const input = vi.fn().mockResolvedValue("Answer");
	const response = await degradeQuestion({ select, input }, request);
	expect("comment" in response).toBe(false);
	const { text, words } = formatModelAnswer(response, request.requestId, request.questions);
	expect(text).toBe("q1: A\nq2: B");
	expect(words).toEqual([]);
});
// A partial fallback answer settles like the structured path (`settledQuestionStatus`): the answered
// questions reach the model and the rest are listed as unanswered, never "dismissed" (#4042 review).
it("keeps a partial degraded answer: answered questions reach the model, the rest are unanswered", async () => {
	const select = vi.fn().mockResolvedValueOnce("A").mockResolvedValueOnce(undefined);
	const input = vi.fn();
	const response = await degradeQuestion({ select, input }, request);
	expect(response).toStrictEqual({
		status: "answered",
		resolvedBy: "rpc_connection",
		answers: { q1: { selected: ["A"] } },
		unanswered: ["q2"],
	});
	expect(formatModelAnswer(response, request.requestId, request.questions).text).toBe("q1: A\nUnanswered: q2");
});
it("settles a degraded question with no answer at all as cancelled", async () => {
	const select = vi.fn().mockResolvedValue(undefined);
	const input = vi.fn();
	expect(await degradeQuestion({ select, input }, request)).toStrictEqual({
		status: "cancelled",
		answers: {},
		unanswered: ["q1", "q2"],
	});
});
// An abort is never an answer: the fallback settles it like the structured bridge (cancelled, or
// timed_out when the abort carries that status), keeps what the user had answered, and asks nothing more.
const threeQuestions = {
	...request,
	questions: ["q1", "q2", "q3"].map((id) => ({ ...request.questions[0], id, header: id, question: id })),
};
const abortOnSecondSelect = (controller: AbortController, reason?: string) =>
	vi
		.fn()
		.mockResolvedValueOnce("A")
		.mockImplementationOnce(async () => {
			controller.abort(reason);
			return undefined;
		})
		.mockResolvedValue("B");
it("settles a fallback aborted partway as cancelled, keeping the partial answers and asking nothing more", async () => {
	const controller = new AbortController();
	const select = abortOnSecondSelect(controller);
	const input = vi.fn();
	const response = await degradeQuestion({ select, input }, threeQuestions, { signal: controller.signal });
	expect(response).toStrictEqual({
		status: "cancelled",
		answers: { q1: { selected: ["A"] } },
		unanswered: ["q2", "q3"],
	});
	expect(select).toHaveBeenCalledTimes(2);
	expect(input).not.toHaveBeenCalled();
});
it("settles a fallback aborted with a timeout as timed_out, keeping the partial answers", async () => {
	const controller = new AbortController();
	const select = abortOnSecondSelect(controller, "timed_out");
	const response = await degradeQuestion({ select, input: vi.fn() }, threeQuestions, { signal: controller.signal });
	expect(response).toMatchObject({
		status: "timed_out",
		answers: { q1: { selected: ["A"] } },
		unanswered: ["q2", "q3"],
	});
	expect(response.resolvedBy).toBeUndefined();
	expect(typeof response.autoResolvedAfterMs).toBe("number");
	expect(select).toHaveBeenCalledTimes(2);
});
it("opens no dialog when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const select = vi.fn();
	expect(await degradeQuestion({ select, input: vi.fn() }, request, { signal: controller.signal })).toStrictEqual({
		status: "cancelled",
		answers: {},
		unanswered: ["q1", "q2"],
	});
	expect(select).not.toHaveBeenCalled();
});
it("broadcasts, replays once after message end, and forgets resolved questions", async () => {
	const writer = new SessionEventWriter(() => {});
	const records = new Map<string, string[]>();
	const attach = (id: string) => {
		const lines: string[] = [];
		records.set(id, lines);
		writer.registerConnection(id, { writeRaw: (line) => lines.push(line), waitForBackpressure: async () => {} });
		writer.attachConnectionToSession(id, "s");
	};
	attach("a");
	attach("b");
	const bridge = new ConnectionQuestionBridge((record) => {
		writer.withConnection("a", () => writer.enqueue("s", record));
	});
	const answer = bridge.ask(request);
	writer.enqueue("s", { type: "message_end" });
	await writer.flush();
	expect(records.get("a")?.filter((line) => line.includes('"method":"question"'))).toHaveLength(1);
	expect(records.get("b")?.filter((line) => line.includes('"method":"question"'))).toHaveLength(1);
	attach("c");
	writer.attachConnectionToSession("c", "s");
	await writer.flush();
	expect(records.get("c")).toHaveLength(1);
	const id = bridge.pendingQuestions()[0].id;
	expect(
		bridge.respond({ type: "extension_ui_response", id, answers: { q1: { selected: ["A"] } }, comment: "" }),
	).toBe(true);
	expect(await answer).toMatchObject({
		status: "answered",
		answers: { q1: { selected: ["A"] } },
		unanswered: ["q2"],
	});
	await writer.flush();
	for (const peer of ["a", "b", "c"])
		expect(records.get(peer)?.filter((line) => line.includes('"question_resolved"'))).toHaveLength(1);
	expect(bridge.respond({ type: "extension_ui_response", id, answers: {} })).toBe("question_already_resolved");
	attach("d");
	await writer.flush();
	expect(records.get("d")).toHaveLength(0);
});
it("keeps an empty response pending", async () => {
	const bridge = new ConnectionQuestionBridge(() => {});
	const controller = new AbortController();
	const answer = bridge.ask(request, { signal: controller.signal });
	const id = bridge.pendingQuestions()[0].id;
	expect(bridge.respond({ type: "extension_ui_response", id, answers: {}, comment: "" })).toBe("question_incomplete");
	expect(bridge.pendingQuestions()).toHaveLength(1);
	controller.abort();
	expect(await answer).toMatchObject({ status: "cancelled" });
});
it("progress rearms idle timeout and timeout retains the draft", async () => {
	vi.useFakeTimers();
	const output: object[] = [];
	const onProgress = vi.fn();
	const bridge = new ConnectionQuestionBridge((record) => output.push(record));
	const answer = bridge.ask(request, { onProgress });
	const id = bridge.pendingQuestions()[0].id;
	await vi.advanceTimersByTimeAsync(900);
	bridge.progress({ type: "extension_ui_progress", id, answers: { q1: { selected: ["A"] } } });
	expect(onProgress).toHaveBeenCalledOnce();
	expect(output.at(-1)).toMatchObject({ type: "question_updated", remainingMs: 1000 });
	await vi.advanceTimersByTimeAsync(999);
	expect(bridge.pendingQuestions()).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(await answer).toMatchObject({ status: "timed_out", answers: { q1: { selected: ["A"] } } });
	expect(output.at(-1)).toMatchObject({ type: "question_resolved", outcome: "timed_out" });
});
it("broadcasts the timeout the extension resolved instead of a bare cancel", async () => {
	const output: object[] = [];
	const bridge = new ConnectionQuestionBridge((record) => output.push(record));
	const controller = new AbortController();
	const answer = bridge.ask(request, { signal: controller.signal });
	// The ask-user extension owns the authoritative idle timer: it resolves the
	// pending question `timed_out` and aborts the dialog carrying that status.
	controller.abort("timed_out");
	expect(await answer).toMatchObject({ status: "timed_out", unanswered: ["q1", "q2"] });
	const resolved = output.filter((record) => "type" in record && record.type === "question_resolved");
	expect(resolved).toHaveLength(1);
	expect(resolved[0]).toMatchObject({ outcome: "timed_out", unanswered: ["q1", "q2"] });
	expect(bridge.pendingQuestions()).toHaveLength(0);
});
it("cancels once on close and abort", async () => {
	const output: object[] = [];
	const bridge = new ConnectionQuestionBridge((record) => output.push(record));
	const controller = new AbortController();
	const answer = bridge.ask(request, { signal: controller.signal });
	controller.abort();
	bridge.cancelAll();
	expect(await answer).toMatchObject({ status: "cancelled" });
	expect(output.filter((record) => "type" in record && record.type === "question_resolved")).toHaveLength(1);
});
