import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinModel as getModel } from "../src/providers/all.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";
import {
	CLAUDE_CODE_VERSION_PIN_ENV,
	compareClaudeCodeVersions,
	installClaudeCodeVersionStore,
} from "../src/utils/claude-code-version.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

// Anthropic rejects OAuth requests whose advertised Claude Code version is older
// than this with `claude_code_version_too_old`; the advertised version must never
// fall below it. Claude Sonnet 5.5 raised it to 2.1.284 (senpi#2321).
const MINIMUM_CLAUDE_CODE_VERSION = "2.1.284";

function tooOld400(required: string): string {
	return `400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.284 does not support this model; version ${required} or newer is required. Run 'claude update', or update the Claude desktop app, then try again.","error_code":"claude_code_version_too_old"}}`;
}

type ClientHeaders = Record<string, string | null>;

const mockState = vi.hoisted(() => ({
	clients: [] as ClientHeaders[],
	failuresBeforeSuccess: [] as Error[],
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		constructor(options: { defaultHeaders?: ClientHeaders }) {
			mockState.clients.push(options.defaultHeaders ?? {});
		}

		beta = {
			messages: {
				create: () => ({
					asResponse: async () => {
						const failure = mockState.failuresBeforeSuccess.shift();
						if (failure) throw failure;
						return createSseResponse();
					},
				}),
			},
		};
	}

	return { default: FakeAnthropic };
});

function claudeCliVersion(headers: ClientHeaders | undefined): string {
	const match = /^claude-cli\/(\d+\.\d+\.\d+)$/.exec(headers?.["user-agent"] ?? "");
	if (!match?.[1]) throw new Error(`user-agent is not a claude-cli version: ${String(headers?.["user-agent"])}`);
	return match[1];
}

// A version newer than the one a request advertises by default, so a rejection naming it is always
// a real upgrade (a literal here broke when the bundled version moved past it: senpi#2545).
function newerThan(version: string, patches: number): string {
	const [major, minor, patch] = version.split(".").map(Number);
	return `${major}.${minor}.${(patch ?? 0) + patches}`;
}

function tooOldError(required: string): Error {
	const error = new Error(tooOld400(required));
	Object.assign(error, { status: 400 });
	return error;
}

describe("Anthropic OAuth Claude Code identity headers", () => {
	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
	const model = getModel("anthropic", "claude-sonnet-4-5");
	const oauthToken = "sk-ant-oat01-test-token";

	beforeEach(() => {
		mockState.clients.length = 0;
		mockState.failuresBeforeSuccess.length = 0;
		installClaudeCodeVersionStore(null);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("advertises a claude-cli user-agent at or above Anthropic's minimum supported version", async () => {
		await streamAnthropic(model, normalizeContext(context), { apiKey: oauthToken }).result();

		const headers = mockState.clients.at(-1);
		expect(headers?.["x-app"]).toBe("cli");
		expect(compareClaudeCodeVersions(claudeCliVersion(headers), MINIMUM_CLAUDE_CODE_VERSION)).toBeGreaterThanOrEqual(
			0,
		);
	});

	it(`advertises the exact version pinned in ${CLAUDE_CODE_VERSION_PIN_ENV}`, async () => {
		vi.stubEnv(CLAUDE_CODE_VERSION_PIN_ENV, "2.1.250");

		await streamAnthropic(model, normalizeContext(context), { apiKey: oauthToken }).result();

		expect(claudeCliVersion(mockState.clients.at(-1))).toBe("2.1.250");
	});

	async function advertisedByDefault(): Promise<string> {
		await streamAnthropic(model, normalizeContext(context), { apiKey: oauthToken }).result();
		const version = claudeCliVersion(mockState.clients.at(-1));
		mockState.clients.length = 0;
		return version;
	}

	it("retries once with the version a claude_code_version_too_old rejection names", async () => {
		const required = newerThan(await advertisedByDefault(), 1);
		mockState.failuresBeforeSuccess.push(tooOldError(required));

		const message = await streamAnthropic(model, normalizeContext(context), { apiKey: oauthToken }).result();

		expect(message.stopReason).toBe("stop");
		expect(mockState.clients.map(claudeCliVersion)).toEqual([expect.any(String), required]);
	});

	it("gives up after one retry and names the advertised version and the pin variable", async () => {
		const advertised = await advertisedByDefault();
		const required = newerThan(advertised, 1);
		mockState.failuresBeforeSuccess.push(tooOldError(required), tooOldError(newerThan(advertised, 6)));

		const message = await streamAnthropic(model, normalizeContext(context), { apiKey: oauthToken }).result();

		expect(message.stopReason).toBe("error");
		expect(mockState.clients).toHaveLength(2);
		expect(message.errorMessage).toContain(`claude-cli/${required}`);
		expect(message.errorMessage).toContain(CLAUDE_CODE_VERSION_PIN_ENV);
	});

	it("never retries a too-old rejection when the version is pinned", async () => {
		vi.stubEnv(CLAUDE_CODE_VERSION_PIN_ENV, "2.1.250");
		mockState.failuresBeforeSuccess.push(tooOldError("2.1.251"));

		const message = await streamAnthropic(model, normalizeContext(context), { apiKey: oauthToken }).result();

		expect(message.stopReason).toBe("error");
		expect(mockState.clients).toHaveLength(1);
	});
});
