import { afterEach, describe, expect, it } from "vitest";
import {
	type CapturedRequest,
	closeServer,
	messages,
	RETRY_GUIDANCE,
	runScenario,
	TRUNCATION_ERROR,
} from "./support/anthropic-recovery-wire.ts";

const servers: Parameters<typeof closeServer>[0][] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

function assertMockHeaders(requests: CapturedRequest[]): void {
	expect(requests).toHaveLength(2);
	for (const request of requests) {
		expect(request.headers["x-api-key"]).toBe("mock-anthropic-key");
		expect(request.headers.authorization).toBeUndefined();
		expect(request.rawBody).not.toContain("mock-anthropic-key");
		expect(request.rawBody).not.toMatch(/(?:sk-ant-|ANTHROPIC_API_KEY|authorization)/iu);
	}
}

function recoveredPair(request: CapturedRequest): {
	toolUse: Record<string, unknown>;
	toolResult: Record<string, unknown>;
} {
	const transcript = messages(request);
	const assistantIndex = transcript.findIndex(
		(message) => message.role === "assistant" && message.content.some((block) => block.type === "tool_use"),
	);
	expect(assistantIndex).toBeGreaterThanOrEqual(0);
	const assistant = transcript[assistantIndex]!;
	const user = transcript[assistantIndex + 1];
	expect(assistant.role).toBe("assistant");
	expect(user?.role).toBe("user");
	expect(assistant.content.map((block) => block.type)).toEqual(["text", "tool_use"]);
	expect(user?.content.map((block) => block.type)).toEqual(["tool_result"]);
	return { toolUse: assistant.content[1]!, toolResult: user!.content[0]! };
}

describe("Claude XML tool-call recovery through Anthropic wire format", () => {
	it("executes a complete fragmented CRLF invoke and replays an exact Anthropic tool pair", async () => {
		const result = await runScenario("complete");
		servers.push(result.endpoint.server);
		assertMockHeaders(result.endpoint.requests);
		expect(result.executeCount).toBe(1);
		expect(result.endpoint.closeEventCount()).toBe(1);
		expect(result.eventOrder.filter((event) => event === "toolcall_start")).toHaveLength(1);
		expect(result.eventOrder.filter((event) => event === "toolcall_end")).toHaveLength(1);
		expect(result.eventOrder.indexOf("toolcall_start")).toBeLessThan(result.eventOrder.indexOf("toolcall_end"));

		const { toolUse, toolResult } = recoveredPair(result.endpoint.requests[1]!);
		expect(toolUse).toMatchObject({ type: "tool_use", name: "Echo", input: { value: "hello" } });
		expect(typeof toolUse.id).toBe("string");
		expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: toolUse.id, content: "echo:hello" });
		expect(toolResult.is_error === false || toolResult.is_error === undefined).toBe(true);
		expect(result.endpoint.requests[1]!.rawBody).not.toMatch(/<\/?(?:antml:)?(?:invoke|parameter)/u);

		const recovered = result.session.messages.find(
			(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
		);
		expect(recovered).toBeDefined();
		if (recovered?.role !== "assistant") throw new Error("Expected recovered assistant message");
		expect(recovered.content).toEqual([
			expect.objectContaining({ type: "text", index: 0, text: "I will check. " }),
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

	it("does not execute a truncated fragmented invoke and replays an exact corrective Anthropic pair", async () => {
		const result = await runScenario("truncated");
		servers.push(result.endpoint.server);
		assertMockHeaders(result.endpoint.requests);
		expect(result.executeCount).toBe(0);
		expect(result.endpoint.closeEventCount()).toBe(0);
		expect(result.eventOrder.filter((event) => event === "toolcall_start")).toHaveLength(1);
		expect(result.eventOrder.filter((event) => event === "toolcall_end")).toHaveLength(1);

		const { toolUse, toolResult } = recoveredPair(result.endpoint.requests[1]!);
		expect(toolUse).toMatchObject({ type: "tool_use", name: "Echo", input: {} });
		expect(typeof toolUse.id).toBe("string");
		expect(toolResult).toMatchObject({
			type: "tool_result",
			tool_use_id: toolUse.id,
			is_error: true,
			content: `${TRUNCATION_ERROR}. ${RETRY_GUIDANCE}`,
		});
		expect(result.endpoint.requests[1]!.rawBody).not.toMatch(/<\/?(?:antml:)?(?:invoke|parameter)/u);

		const recovered = result.session.messages.find(
			(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
		);
		expect(recovered).toBeDefined();
		if (recovered?.role !== "assistant") throw new Error("Expected recovered assistant message");
		expect(recovered.content).toEqual([
			expect.objectContaining({ type: "text", index: 0, text: "I will check. " }),
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
