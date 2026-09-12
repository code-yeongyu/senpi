import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideExecutableDeps,
	resetExecutableDeps,
} from "../src/core/extensions/builtin/claude-sdk-oauth/executable.ts";
import { overrideSdkBoundary } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { streamClaudeSdkOauth } from "../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";
import { installSingleAccountLane, resetScriptedSdk } from "./helpers/claude-sdk-oauth-scripted-sdk.ts";

/**
 * code-yeongyu/senpi#1541 item 4: `query()` is never reached without a spawnable executable. A miss is
 * senpi's own error naming every candidate, not the SDK's generic "native binary not found" wrapper.
 */

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const HOISTED_SIDECAR = "C:\\npm\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe";

afterEach(() => {
	resetExecutableDeps();
	resetScriptedSdk();
});

describe("streamClaudeSdkOauth executable gate", () => {
	it("fails the turn with senpi's candidate list and never calls the SDK when nothing is spawnable", async () => {
		await installSingleAccountLane();
		let queries = 0;
		overrideSdkBoundary({
			query: () => {
				queries += 1;
				throw new Error("query must not be reached");
			},
		});
		overrideExecutableDeps({
			platform: "win32",
			arch: "x64",
			env: (name) => ({ CLAUDE_CODE_EXECUTABLE: "C:\\custom\\claude.exe", PATH: "C:\\bin" })[name],
			resolve: () => HOISTED_SIDECAR,
			isFile: () => false,
		});

		const result = await streamClaudeSdkOauth(model, { messages: [] }).result();

		expect(queries).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("\\\\?\\C:\\custom\\claude.exe");
		expect(result.errorMessage).toContain(`\\\\?\\${HOISTED_SIDECAR}`);
		expect(result.errorMessage).toContain("claude on PATH");
		expect(result.errorMessage).not.toContain("options.pathToClaudeCodeExecutable");
	});

	it("passes the validated spelling to the SDK when a candidate is spawnable", async () => {
		await installSingleAccountLane();
		let seen: string | undefined;
		overrideSdkBoundary({
			query: (input) => {
				seen = input.options?.pathToClaudeCodeExecutable;
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "result", subtype: "success", result: "ok", is_error: false } as never;
					},
					async interrupt() {},
					close() {},
				};
			},
		});
		overrideExecutableDeps({
			platform: "win32",
			arch: "x64",
			env: () => undefined,
			resolve: () => HOISTED_SIDECAR,
			isFile: () => true,
		});

		const result = await streamClaudeSdkOauth(model, { messages: [] }).result();

		expect(result.stopReason).not.toBe("error");
		expect(seen).toBe(`\\\\?\\${HOISTED_SIDECAR}`);
	});
});
