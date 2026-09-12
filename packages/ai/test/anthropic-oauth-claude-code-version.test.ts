import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinModel as getModel } from "../src/providers/all.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

// Anthropic rejects OAuth requests whose advertised Claude Code version is older
// than this with `claude_code_version_too_old`; the advertised version must never
// fall below it. Mirrors upstream pi 96317e50 (2.1.75 -> 2.1.251).
const MINIMUM_CLAUDE_CODE_VERSION = [2, 1, 251] as const;

const mockState = vi.hoisted(() => ({
	constructorOptions: undefined as { defaultHeaders?: Record<string, string | null> } | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropic {
		constructor(options: { defaultHeaders?: Record<string, string | null> }) {
			mockState.constructorOptions = options;
		}

		messages = {
			create: () => ({
				asResponse: async () => createSseResponse(),
			}),
		};
	}

	return { default: FakeAnthropic };
});

function parseClaudeCliVersion(userAgent: string | null | undefined): readonly [number, number, number] {
	const match = /^claude-cli\/(\d+)\.(\d+)\.(\d+)$/.exec(userAgent ?? "");
	if (!match) throw new Error(`user-agent is not a claude-cli version: ${String(userAgent)}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

describe("Anthropic OAuth Claude Code identity headers", () => {
	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	beforeEach(() => {
		mockState.constructorOptions = undefined;
	});

	it("advertises a claude-cli user-agent at or above Anthropic's minimum supported version", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-oat01-test-token" });
		await stream.result();

		const userAgent = mockState.constructorOptions?.defaultHeaders?.["user-agent"];
		expect(mockState.constructorOptions?.defaultHeaders?.["x-app"]).toBe("cli");
		expect(compareVersions(parseClaudeCliVersion(userAgent), MINIMUM_CLAUDE_CODE_VERSION)).toBeGreaterThanOrEqual(0);
	});
});
