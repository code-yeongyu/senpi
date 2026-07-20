import { afterEach, describe, expect, it } from "vitest";
import {
	type CapturedRequest,
	closeServer,
	messages,
	RETRY_GUIDANCE,
	runScenario,
	TRUNCATION_ERROR,
} from "./support/openai-recovery-wire.ts";

const servers: Parameters<typeof closeServer>[0][] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

function assertWire(requests: CapturedRequest[]): void {
	expect(requests).toHaveLength(2);
	for (const request of requests) {
		expect(request.headers.authorization).toBe("Bearer mock-openai-key");
		expect(request.headers["content-type"]).toContain("application/json");
		expect(request.rawBody).not.toContain("mock-openai-key");
		expect(request.rawBody).not.toMatch(/OPENAI_API_KEY|authorization/iu);
	}
	const firstMessages = messages(requests[0]!);
	expect(firstMessages.map((message) => message.role)).toEqual(["system", "user"]);
	expect(JSON.stringify(firstMessages[0])).not.toMatch(/<tool_call>|<invoke|tool call format/iu);
}

function recoveredPair(request: CapturedRequest) {
	const transcript = messages(request);
	const assistantIndex = transcript.findIndex(
		(message) => message.role === "assistant" && Array.isArray(message.tool_calls),
	);
	expect(assistantIndex).toBeGreaterThanOrEqual(0);
	const assistant = transcript[assistantIndex]!;
	const tool = transcript[assistantIndex + 1]!;
	expect(transcript.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
	expect(assistant.content).toBe("I will check. ");
	expect(tool.role).toBe("tool");
	return {
		call: (assistant.tool_calls as Array<Record<string, unknown>>)[0]!,
		tool,
	};
}

function recoveredMessage(result: Awaited<ReturnType<typeof runScenario>>) {
	const recovered = result.session.messages.find(
		(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
	);
	expect(recovered).toBeDefined();
	if (recovered?.role !== "assistant") throw new Error("Expected recovered assistant message");
	return recovered;
}

describe("Claude XML tool-call recovery through OpenAI completions wire format", () => {
	it("executes a complete leaked invoke through raw OpenAI SSE and replays tool_calls", async () => {
		const result = await runScenario("complete");
		servers.push(result.endpoint.server);
		assertWire(result.endpoint.requests);
		expect(result.executeCount).toBe(1);
		expect(result.endpoint.closeCount()).toBe(1);
		expect(result.eventOrder.filter((event) => event === "toolcall_start")).toHaveLength(1);
		expect(result.eventOrder.filter((event) => event === "toolcall_end")).toHaveLength(1);
		expect(result.eventOrder.indexOf("toolcall_start")).toBeLessThan(result.eventOrder.indexOf("toolcall_end"));

		const { call, tool } = recoveredPair(result.endpoint.requests[1]!);
		expect(call).toEqual({
			id: "recovered-antml-0",
			type: "function",
			function: { name: "Echo", arguments: '{"value":"hello"}' },
		});
		expect(tool).toEqual({ role: "tool", tool_call_id: "recovered-antml-0", content: "echo:hello" });
		expect(result.endpoint.requests[1]!.rawBody).not.toMatch(/<\/?(?:antml:)?(?:invoke|parameter)/u);
		expect(result.endpoint.requests[1]!.rawBody).not.toContain("<tool_call>");

		const recovered = recoveredMessage(result);
		expect(recovered.content).toEqual([
			expect.objectContaining({ type: "text", text: "I will check. " }),
			expect.objectContaining({
				type: "toolCall",
				id: "recovered-antml-0",
				name: "Echo",
				arguments: { value: "hello" },
			}),
		]);
		expect(JSON.stringify(recovered.content)).not.toMatch(/<\/?(?:antml:)?(?:invoke|parameter)/u);
		expect(result.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "complete final" }],
		});
		result.session.dispose();
	});

	it("safe-fails a truncated leaked invoke through raw OpenAI SSE and replays an error tool message", async () => {
		const result = await runScenario("truncated");
		servers.push(result.endpoint.server);
		assertWire(result.endpoint.requests);
		expect(result.executeCount).toBe(0);
		expect(result.endpoint.closeCount()).toBe(0);
		expect(result.eventOrder.filter((event) => event === "toolcall_start")).toHaveLength(1);
		expect(result.eventOrder.filter((event) => event === "toolcall_end")).toHaveLength(1);

		const { call, tool } = recoveredPair(result.endpoint.requests[1]!);
		expect(call).toEqual({
			id: "recovered-antml-0",
			type: "function",
			function: { name: "Echo", arguments: "{}" },
		});
		expect(tool).toEqual({
			role: "tool",
			tool_call_id: "recovered-antml-0",
			content: `${TRUNCATION_ERROR}. ${RETRY_GUIDANCE}`,
		});
		expect(result.endpoint.requests[1]!.rawBody).not.toMatch(/<\/?(?:antml:)?(?:invoke|parameter)/u);

		const recovered = recoveredMessage(result);
		expect(recovered.content).toEqual([
			expect.objectContaining({ type: "text", text: "I will check. " }),
			expect.objectContaining({
				type: "toolCall",
				id: "recovered-antml-0",
				name: "Echo",
				arguments: {},
				incomplete: true,
				errorMessage: TRUNCATION_ERROR,
			}),
		]);
		expect(JSON.stringify(recovered.content)).not.toMatch(/<\/?(?:antml:)?(?:invoke|parameter)/u);
		expect(result.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "corrective final" }],
		});
		result.session.dispose();
	});
});
