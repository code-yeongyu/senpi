import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { Options } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { configFingerprint } from "../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";
import { HOST_TOOL_POLICY_FINGERPRINT } from "../src/core/extensions/builtin/claude-sdk-oauth/tools.ts";

const STABLE_PROMPT_BODY = [
	"You are senpi, a coding agent.",
	"",
	"## Available Tools",
	"- read: Read file contents",
].join("\n");

function promptWith(date: string, cwd = "/repo"): string {
	return `${STABLE_PROMPT_BODY}\n\nCurrent date: ${date}\nCurrent working directory: ${cwd}`;
}

function options(overrides: Partial<Options> = {}): Options {
	return {
		cwd: "/repo",
		model: "claude-opus-4-5",
		tools: ["Read", "Bash"],
		permissionMode: "dontAsk",
		includePartialMessages: true,
		systemPrompt: promptWith("2026-07-31"),
		settingSources: [],
		...overrides,
	} as Options;
}

function context(): Context {
	return {
		systemPrompt: promptWith("2026-07-31"),
		messages: [],
		tools: [{ name: "read", description: "Read file contents", parameters: { type: "object", properties: {} } }],
	} as unknown as Context;
}

describe("claude-sdk-oauth config fingerprint stability", () => {
	it("is identical for two independently rebuilt but equivalent turns", () => {
		const first = configFingerprint(options(), context(), "oauth-slots", "primary");
		const second = configFingerprint(options(), context(), "oauth-slots", "primary");

		expect(second.systemPromptHash).toBe(first.systemPromptHash);
		expect(second.toolsetHash).toBe(first.toolsetHash);
	});

	it("survives a UTC midnight rollover: only the generated date line changed", () => {
		const before = configFingerprint(
			options({ systemPrompt: promptWith("2026-07-31") }),
			context(),
			"oauth-slots",
			"primary",
		);
		const after = configFingerprint(
			options({ systemPrompt: promptWith("2026-08-01") }),
			context(),
			"oauth-slots",
			"primary",
		);

		expect(after.systemPromptHash).toBe(before.systemPromptHash);
	});

	it("stays fail-closed when the working directory changes", () => {
		const before = configFingerprint(options(), context(), "oauth-slots", "primary");
		const after = configFingerprint(
			options({ cwd: "/elsewhere", systemPrompt: promptWith("2026-07-31", "/elsewhere") }),
			context(),
			"oauth-slots",
			"primary",
		);

		expect(after.systemPromptHash).not.toBe(before.systemPromptHash);
		expect(after.toolsetHash).not.toBe(before.toolsetHash);
	});

	it("stays fail-closed when a semantic prompt instruction changes", () => {
		const before = configFingerprint(options(), context(), "oauth-slots", "primary");
		const after = configFingerprint(
			options({ systemPrompt: `${promptWith("2026-07-31")}\nAlways respond in Korean.` }),
			context(),
			"oauth-slots",
			"primary",
		);

		expect(after.systemPromptHash).not.toBe(before.systemPromptHash);
	});

	it("stays fail-closed when a tool description changes", () => {
		const changed = {
			systemPrompt: promptWith("2026-07-31"),
			messages: [],
			tools: [
				{ name: "read", description: "Read files differently", parameters: { type: "object", properties: {} } },
			],
		} as unknown as Context;

		const before = configFingerprint(options(), context(), "oauth-slots", "primary");
		const after = configFingerprint(options(), changed, "oauth-slots", "primary");

		expect(after.toolsetHash).not.toBe(before.toolsetHash);
	});

	it("fingerprints the host tool policy by version instead of function source", () => {
		const policyProbe = configFingerprint(options(), context(), "oauth-slots", "primary");
		const withDifferentCallbackIdentity = configFingerprint(
			options({ canUseTool: async () => ({ behavior: "deny", message: "no" }) } as Partial<Options>),
			context(),
			"oauth-slots",
			"primary",
		);

		expect(HOST_TOOL_POLICY_FINGERPRINT).toBe("host-tool-denial-v1");
		expect(withDifferentCallbackIdentity.toolsetHash).toBe(policyProbe.toolsetHash);
	});

	it("stays fail-closed when the resolved Claude executable changes", () => {
		const before = configFingerprint(options(), context(), "oauth-slots", "primary");
		const after = configFingerprint(
			options({ pathToClaudeCodeExecutable: "/other/claude" }),
			context(),
			"oauth-slots",
			"primary",
		);

		expect(after.toolsetHash).not.toBe(before.toolsetHash);
	});
});
