/**
 * A terminal control endpoint answers `extension_ui_response` with the FRAME's `id`, the same contract
 * as a multi-session host: `uiRequestId` names the question being answered, and the short form (no
 * `uiRequestId`, `id` = request id) keeps working unchanged.
 */
import { afterEach, expect, it } from "vitest";
import type { QuestionResponse } from "../../src/core/extensions/types.ts";
import { controlRequest } from "../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";

const fixtures: EndpointFixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
});

const QUESTION = { id: "q1", header: "Ship", question: "Ship it?", options: [], multiSelect: false };

async function terminalAsking(...requestIds: string[]) {
	const pending = new Set(requestIds);
	const answered: Array<{ readonly requestId: string; readonly response: QuestionResponse }> = [];
	const fixture = await startEndpoint({
		questions: {
			pendingQuestionIds: () => [...pending],
			pendingQuestion: (requestId) => (pending.has(requestId) ? { questions: [QUESTION] } : undefined),
			answerQuestion: (requestId, response) => {
				if (!pending.delete(requestId)) return false;
				answered.push({ requestId, response });
				return true;
			},
		},
	});
	fixtures.push(fixture);
	const answer = async (frame: Readonly<Record<string, unknown>>) => {
		const reply = await controlRequest(fixture.socket, { type: "extension_ui_response", ...frame });
		if (reply.kind !== "answered") throw new Error(`control socket closed on ${JSON.stringify(frame)}`);
		return reply.record;
	};
	return { answer, answered };
}

it("answers a uiRequestId answer under the frame id, once, and refuses a replay and an unknown request under their frame ids", async () => {
	const { answer, answered } = await terminalAsking("ask-1");

	const first = await answer({ id: "answer-1", uiRequestId: "ask-1", answers: { q1: { selected: ["yes"] } } });
	expect(first).toEqual({ id: "answer-1", type: "response", command: "extension_ui_response", success: true });
	expect(answered).toEqual([
		{
			requestId: "ask-1",
			response: {
				status: "answered",
				resolvedBy: "control_endpoint",
				answers: { q1: { selected: ["yes"] } },
				unanswered: [],
			},
		},
	]);

	expect(await answer({ id: "answer-2", uiRequestId: "ask-1", answers: { q1: { selected: ["no"] } } })).toMatchObject({
		id: "answer-2",
		success: false,
		error: "unknown_request",
	});
	expect(await answer({ id: "answer-3", uiRequestId: "no-such-request", answers: {} })).toMatchObject({
		id: "answer-3",
		success: false,
		error: "unknown_request",
	});
	expect(answered).toHaveLength(1);
});

it("keeps the short form: id alone names the question and is answered under that id", async () => {
	const { answer, answered } = await terminalAsking("ask-2");

	expect(await answer({ id: "ask-2", answers: {}, comment: "ship it" })).toEqual({
		id: "ask-2",
		type: "response",
		command: "extension_ui_response",
		success: true,
	});
	expect(answered).toEqual([
		{
			requestId: "ask-2",
			response: {
				status: "comment-submitted",
				resolvedBy: "control_endpoint",
				answers: {},
				unanswered: ["q1"],
				comment: "ship it",
			},
		},
	]);
});

it("answers the legacy value frame (id = question id) as before: invalid_response under that id, question still pending", async () => {
	const { answer, answered } = await terminalAsking("ask-4");

	expect(await answer({ id: "ask-4", value: "yes" })).toEqual({
		id: "ask-4",
		type: "response",
		command: "extension_ui_response",
		success: false,
		error: "invalid_response",
	});
	expect(answered).toEqual([]);
});

it("refuses a malformed answer under the frame id and leaves the question pending", async () => {
	const { answer, answered } = await terminalAsking("ask-3");

	expect(await answer({ id: "answer-4", uiRequestId: "ask-3", answers: "yes" })).toMatchObject({
		id: "answer-4",
		success: false,
		error: "invalid_response",
	});
	expect(answered).toEqual([]);
	expect(await answer({ id: "answer-5", uiRequestId: "ask-3", cancelled: true })).toMatchObject({
		id: "answer-5",
		success: true,
	});
});
