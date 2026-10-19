import { arch, platform, release } from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { resetWireIdentityForTests, setWireIdentity } from "../../../ai/src/wire-identity.ts";
import { createOpenAiRemoteCompactionHeaders } from "../../src/core/extensions/builtin/compaction/openai-remote-model.ts";

const CODEX_MODEL = {
	id: "gpt-5.4-codex",
	name: "GPT-5.4 Codex",
	api: "openai-codex-responses",
	provider: "chatgpt-subscription",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
} satisfies Model<"openai-codex-responses">;

describe("remote compaction wire identity", () => {
	afterEach(() => {
		resetWireIdentityForTests();
	});

	it("names the engine identity by default", () => {
		const headers = createOpenAiRemoteCompactionHeaders(CODEX_MODEL, { apiKey: "sk-test" }, "session-1");

		expect(headers?.get("originator")).toBe("senpi");
		expect(headers?.get("user-agent")).toBe(`senpi (${platform()} ${release()}; ${arch()})`);
	});

	it("names a branded distribution", () => {
		setWireIdentity("omo");

		const headers = createOpenAiRemoteCompactionHeaders(CODEX_MODEL, { apiKey: "sk-test" }, "session-1");

		expect(headers?.get("originator")).toBe("omo");
		expect(headers?.get("user-agent")).toBe(`omo (${platform()} ${release()}; ${arch()})`);
	});
});
