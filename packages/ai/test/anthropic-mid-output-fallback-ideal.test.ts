import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import { wrapStreamWithModelRecovery } from "../src/tool-call-middleware/index.ts";

function responseFor(events: Array<{ event: string; data: unknown }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function clientFor(response: Response): Anthropic {
	return {
		beta: { messages: { create: () => ({ asResponse: async () => response }) } },
	} as unknown as Anthropic;
}

describe("Anthropic mid-output fallback", () => {
	it.each([
		[false, false, false],
		[true, false, false],
		[true, true, false],
		[true, false, true],
		[true, true, true],
	])("honors boundary with recovery=%s, truncated=%s, survivor=%s", async (recovery, truncated, survivor) => {
		const events = [
			{ type: "message_start", message: { id: "msg-tools", model: "claude-opus-5", usage: {} } },
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "abandoned", name: "must_not_run", input: {} },
			},
			{ type: "content_block_stop", index: 0 },
			{
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "fallback",
					from: { model: "claude-opus-5" },
					to: { model: "claude-opus-4-8" },
				},
			},
			{ type: "content_block_stop", index: 1 },
			{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "safe answer" } },
			{ type: "content_block_stop", index: 2 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
			{ type: "message_stop" },
		];
		if (survivor) {
			events.splice(
				events.length - 2,
				0,
				{
					type: "content_block_start",
					index: 3,
					content_block: { type: "tool_use", id: "survivor", name: "must_not_run", input: {} },
				},
				{ type: "content_block_stop", index: 3 },
			);
		}
		const model = getModel("anthropic", "claude-opus-5");
		const raw = streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{
				client: clientFor(
					responseFor((truncated ? events.slice(0, -2) : events).map((data) => ({ event: data.type, data }))),
				),
				abortServerSideFallback: false,
			},
		);
		const result = await (recovery
			? wrapStreamWithModelRecovery(raw, model, [
					{
						name: "must_not_run",
						description: "Abandoned tool",
						parameters: Type.Object({}),
					},
				])
			: raw
		).result();

		expect(result.stopReason).toBe(survivor ? "toolUse" : truncated ? "error" : "stop");
		expect(result.content.filter((block) => block.type === "toolCall").map((block) => block.id)).toEqual(
			survivor ? ["survivor"] : [],
		);
		expect(result.content.filter((block) => block.type === "text").map((block) => block.text)).toEqual([
			"safe answer",
		]);
	});

	it("routes a fallback marker after partial output through server fallback handling", async () => {
		const result = await streamAnthropic(
			getModel("anthropic", "claude-opus-5"),
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{
				client: clientFor(
					responseFor([
						{
							event: "message_start",
							data: { type: "message_start", message: { id: "msg", model: "claude-opus-5", usage: {} } },
						},
						{
							event: "content_block_start",
							data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } },
						},
						{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
						{
							event: "content_block_start",
							data: {
								type: "content_block_start",
								index: 1,
								content_block: {
									type: "fallback",
									from: { model: "claude-opus-5" },
									to: { model: "claude-opus-4-8" },
								},
							},
						},
					]),
				),
				abortServerSideFallback: true,
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.stopDetails?.type).toBe("refusal");
		expect(result.content).toEqual([]);
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "server_fallback_aborted",
					details: { from: "claude-opus-5", to: "claude-opus-4-8" },
				}),
			]),
		);
		expect(result.errorMessage).toContain("Server-side fallback");
		expect(result.errorMessage).not.toContain("unsupported mid-output");
	});

	it("continues a mid-output fallback stream when client abort is disabled", async () => {
		const result = await streamAnthropic(
			{
				...getModel("anthropic", "claude-opus-5"),
				cost: { input: 11, output: 13, cacheRead: 0, cacheWrite: 0 },
				compat: {
					allowedFallbackModels: [
						{
							provider: "anthropic",
							model: "claude-opus-4-8",
							cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{
				client: clientFor(
					responseFor([
						{
							event: "message_start",
							data: {
								type: "message_start",
								message: { id: "msg-continue", model: "claude-opus-5", usage: {} },
							},
						},
						{
							event: "content_block_start",
							data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "before " } },
						},
						{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
						{
							event: "content_block_start",
							data: {
								type: "content_block_start",
								index: 1,
								content_block: {
									type: "fallback",
									from: { model: "claude-opus-5" },
									to: { model: "claude-opus-4-8" },
								},
							},
						},
						{
							event: "content_block_start",
							data: { type: "content_block_start", index: 2, content_block: { type: "text", text: "after" } },
						},
						{ event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
						{
							event: "message_delta",
							data: {
								type: "message_delta",
								delta: { stop_reason: "end_turn" },
								usage: { input_tokens: 1_000_000, output_tokens: 2_000_000 },
							},
						},
						{ event: "message_stop", data: { type: "message_stop" } },
					]),
				),
				abortServerSideFallback: false,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe("claude-opus-4-8");
		expect(result.usage.cost).toMatchObject({ input: 2, output: 6, total: 8 });
		expect(result.content).toEqual([
			{ type: "text", text: "before " },
			{
				type: "providerNative",
				subtype: "fallback",
				raw: { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
				index: 1,
			},
			{ type: "text", text: "after" },
		]);
	});
});
