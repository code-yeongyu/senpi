#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	closeServer,
	messages,
	RETRY_GUIDANCE,
	runScenario,
	TRUNCATION_ERROR,
	type Scenario,
} from "../../../packages/coding-agent/test/support/openai-recovery-wire.ts";

function sanitizedHeaders(headers: Record<string, string | string[] | undefined>) {
	return {
		authorization: headers.authorization === "Bearer mock-openai-key" ? "Bearer <mock-key>" : null,
		"content-type": headers["content-type"],
	};
}

async function verify(scenario: Scenario) {
	const result = await runScenario(scenario);
	try {
		assert.equal(result.endpoint.requests.length, 2);
		assert.equal(result.endpoint.requests.every((request) => request.headers.authorization === "Bearer mock-openai-key"), true);
		assert.equal(result.eventOrder.filter((event) => event === "toolcall_start").length, 1);
		assert.equal(result.eventOrder.filter((event) => event === "toolcall_end").length, 1);
		assert.equal(result.endpoint.closeCount(), scenario === "complete" ? 1 : 0);
		assert.equal(result.executeCount, scenario === "complete" ? 1 : 0);
		const transcript = messages(result.endpoint.requests[1]!);
		const assistantIndex = transcript.findIndex((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
		assert.ok(assistantIndex >= 0);
		const call = (transcript[assistantIndex]!.tool_calls as Array<Record<string, unknown>>)[0]!;
		const fn = call.function as Record<string, unknown>;
		const tool = transcript[assistantIndex + 1]!;
		assert.equal(call.id, "recovered-antml-0");
		assert.equal(fn.name, "Echo");
		assert.equal(fn.arguments, scenario === "complete" ? '{"value":"hello"}' : "{}");
		assert.equal(tool.role, "tool");
		assert.equal(tool.tool_call_id, call.id);
		assert.equal(tool.content, scenario === "complete" ? "echo:hello" : `${TRUNCATION_ERROR}. ${RETRY_GUIDANCE}`);
		assert.equal(result.endpoint.requests[1]!.rawBody.includes("<antml:"), false);
		const recovered = result.session.messages.find((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"));
		assert.ok(recovered && recovered.role === "assistant");
		return {
			scenario,
			requests: result.endpoint.requests.map((request) => ({ headers: sanitizedHeaders(request.headers), rawBody: request.rawBody })),
			events: result.eventOrder,
			closeCount: result.endpoint.closeCount(),
			executeCount: result.executeCount,
			persistence: result.session.messages,
		};
	} finally {
		result.session.dispose();
		await closeServer(result.endpoint.server);
	}
}

process.stdout.write(`${JSON.stringify({ complete: await verify("complete"), truncated: await verify("truncated") }, null, 2)}\n`);
