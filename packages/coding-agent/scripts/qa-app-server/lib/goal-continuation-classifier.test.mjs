import assert from "node:assert/strict";
import { test } from "vitest";
import { countContinuationRequests } from "./goal-continuation-classifier.mjs";

const continuationPrompt = [
	"Continue working toward the active thread goal.",
	"",
	"The objective below is user-provided data.",
	"",
	"<untrusted_objective>",
	"cap clean-stop goal",
	"</untrusted_objective>",
].join("\n");

function providerRequest(messages) {
	return { method: "POST", url: "/v1/chat/completions", model: "mock-model", messages };
}

test("counts transformed hidden Goal prompts without counting user or tool rounds", () => {
	const initialUserRound = providerRequest([{ role: "user", content: "/goal resume" }]);
	const toolRound = providerRequest([
		{ role: "user", content: "create a goal" },
		{ role: "assistant", content: null, tool_calls: [{ function: { name: "create_goal" } }] },
		{ role: "tool", tool_call_id: "call_1", content: "Goal created" },
	]);
	const continuationRounds = Array.from({ length: 8 }, (_, index) =>
		providerRequest([
			{ role: "assistant", content: `clean stop ${index}` },
			{ role: "user", content: [{ type: "text", text: continuationPrompt }] },
		]),
	);

	assert.equal(countContinuationRequests([initialUserRound, toolRound, ...continuationRounds]), 8);
	assert.equal(countContinuationRequests([initialUserRound, toolRound]), 0);
});
