import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

// Todo 9 (senpi#1989) acceptance (a): parsing --provider with a legacy id fails
// with a message containing BOTH the old and the new id - never a generic
// "Unknown provider".
describe("--provider rejects a typed legacy provider id (senpi#1989)", () => {
	it("fails naming both openai-codex and chatgpt-subscription", () => {
		expect(() => parseArgs(["--provider", "openai-codex"])).toThrow(/openai-codex/);
		expect(() => parseArgs(["--provider", "openai-codex"])).toThrow(/chatgpt-subscription/);
	});

	it("fails naming both claude-sdk-oauth and anthropic-subscription", () => {
		expect(() => parseArgs(["--provider", "claude-sdk-oauth"])).toThrow(/anthropic-subscription/);
		expect(() => parseArgs(["--provider", "claude-sdk-oauth"])).toThrow(/anthropic-subscription/);
	});

	it("accepts the canonical ids and the untouched API-key providers", () => {
		expect(parseArgs(["--provider", "chatgpt-subscription"]).provider).toBe("chatgpt-subscription");
		expect(parseArgs(["--provider", "anthropic-subscription"]).provider).toBe("anthropic-subscription");
		expect(parseArgs(["--provider", "anthropic"]).provider).toBe("anthropic");
		expect(parseArgs(["--provider", "openai"]).provider).toBe("openai");
	});
});
