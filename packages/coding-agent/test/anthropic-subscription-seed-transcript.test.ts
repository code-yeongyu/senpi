import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildSeedTranscript,
	claudeTranscriptPath,
	writeSeedTranscript,
} from "../src/core/extensions/builtin/anthropic-subscription/history-transcript.ts";

const SESSION_ID = "6f1d7c1e-3d0a-4c39-9f5e-0b8a3e2f4a11";
const FOREIGN_TOOL_CALL_ID = "call_x|fc_y";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SIGNATURE = "sig-opaque-anthropic-thinking";

const model: Model<Api> = {
	id: "claude-sonnet-4-6",
	name: "claude-sonnet-4-6",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function threeTurnHistory(): Context {
	return {
		systemPrompt: "system prompt is not part of the transcript",
		messages: [
			{ role: "user", content: "Look at the screenshot.", timestamp: 1_790_000_000_000 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Plan from another model.", thinkingSignature: "foreign-signature" },
					{ type: "text", text: "I will read it." },
					{ type: "toolCall", id: FOREIGN_TOOL_CALL_ID, name: "read", arguments: { path: "shot.png" } },
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
				usage,
				stopReason: "toolUse",
				timestamp: 1_790_000_001_000,
			},
			{
				role: "toolResult",
				toolCallId: FOREIGN_TOOL_CALL_ID,
				toolName: "read",
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: PNG_1X1, mimeType: "image/png" },
				],
				isError: false,
				timestamp: 1_790_000_002_000,
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "The screenshot shows a login form.", thinkingSignature: SIGNATURE },
					{ type: "text", text: "It is a login form." },
				],
				api: "claude-sdk-oauth",
				provider: "anthropic-subscription",
				model: "claude-sonnet-4-6",
				usage,
				stopReason: "stop",
				timestamp: 1_790_000_003_000,
			},
			{ role: "user", content: "What is the next step?", timestamp: 1_790_000_004_000 },
		],
	};
}

type Block = { type: string; [key: string]: unknown };

function blocksOf(message: unknown): Block[] {
	const content = (message as { content?: unknown }).content;
	expect(Array.isArray(content)).toBe(true);
	return content as Block[];
}

describe("anthropic-subscription seeded Claude Code transcript", () => {
	let root = "";
	let configDir = "";
	let previousConfigDir: string | undefined;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-seed-transcript-")));
		configDir = join(root, "claude-config");
		previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = configDir;
	});

	afterEach(() => {
		if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
		rmSync(root, { recursive: true, force: true });
	});

	async function seedAndRead(cwd: string) {
		const seed = buildSeedTranscript(threeTurnHistory(), { sessionId: SESSION_ID, cwd, model, cacheTtl: "1h" });
		const path = writeSeedTranscript(configDir, cwd, seed.entries);
		const messages = await getSessionMessages(SESSION_ID, { dir: cwd });
		return { seed, path, messages };
	}

	it("writes the history before the final user message as native frames the SDK reads back in order", async () => {
		const cwd = join(root, "work");
		mkdirSync(cwd);
		const { seed, path, messages } = await seedAndRead(cwd);

		expect(path).toBe(claudeTranscriptPath(configDir, cwd, SESSION_ID));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(messages.map((message) => message.type)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(messages.map((message) => message.uuid)).toEqual(seed.entries.map((entry) => entry.uuid));

		const firstAssistant = blocksOf(messages[1]?.message);
		// Thinking from another provider is never replayed as a thinking block (its signature is foreign).
		expect(firstAssistant.map((block) => block.type)).toEqual(["text", "text", "tool_use"]);
		expect(firstAssistant[0]).toEqual({ type: "text", text: "Plan from another model." });
		const toolUse = firstAssistant[2];
		expect(toolUse?.name).toBe("Read");
		expect(toolUse?.input).toEqual({ path: "shot.png" });
		const toolUseId = String(toolUse?.id);
		expect(toolUseId).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(toolUseId).not.toBe(FOREIGN_TOOL_CALL_ID);

		const toolResultBlocks = blocksOf(messages[2]?.message);
		expect(toolResultBlocks).toHaveLength(1);
		const toolResult = toolResultBlocks[0];
		expect(toolResult?.type).toBe("tool_result");
		expect(toolResult?.tool_use_id).toBe(toolUseId);
		expect(toolResult?.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } },
		]);
		expect(seed.entries[2]?.sourceToolAssistantUUID).toBe(seed.entries[1]?.uuid);

		const lastAssistant = blocksOf(messages[3]?.message);
		expect(lastAssistant[0]).toEqual({
			type: "thinking",
			thinking: "The screenshot shows a login form.",
			signature: SIGNATURE,
		});
		expect(lastAssistant[1]).toEqual({
			type: "text",
			text: "It is a login form.",
			cache_control: { type: "ephemeral", ttl: "1h" },
		});
		// Exactly one senpi breakpoint: the tail of the seeded history.
		expect(JSON.stringify(seed.entries.map((entry) => entry.message)).match(/cache_control/g)).toHaveLength(1);

		// Context indexes are 1-based message counts, the same keys the session binding uses.
		expect([...seed.assistantUuidByIndex.entries()]).toEqual([
			[2, seed.entries[1]?.uuid],
			[4, seed.entries[3]?.uuid],
		]);
		expect(seed.payloadBytes).toBe(
			Buffer.byteLength(JSON.stringify(seed.entries.map((entry) => entry.message)), "utf8"),
		);
	});

	it("rebuilds the same history to byte-identical entries", () => {
		const cwd = join(root, "work");
		const options = { sessionId: SESSION_ID, cwd, model, cacheTtl: "1h" as const };
		expect(JSON.stringify(buildSeedTranscript(threeTurnHistory(), options).entries)).toBe(
			JSON.stringify(buildSeedTranscript(threeTurnHistory(), options).entries),
		);
	});

	it("omits the senpi breakpoint when no cache lifetime is pinned", () => {
		const seed = buildSeedTranscript(threeTurnHistory(), { sessionId: SESSION_ID, cwd: join(root, "work"), model });
		expect(JSON.stringify(seed.entries)).not.toContain("cache_control");
	});

	it("finds the transcript for a working directory whose project name exceeds the CLI's length limit", async () => {
		const segment = "a-very-long-directory-name-for-the-claude-project-key-";
		let cwd = root;
		for (let depth = 0; depth < 5; depth++) cwd = join(cwd, `${segment}${depth}`);
		mkdirSync(cwd, { recursive: true });
		expect(cwd.replace(/[^a-zA-Z0-9]/g, "-").length).toBeGreaterThan(200);

		const { path, messages } = await seedAndRead(cwd);

		expect(path.split("/").at(-2)?.length).toBeGreaterThan(200);
		expect(messages.map((message) => message.type)).toEqual(["user", "assistant", "user", "assistant"]);
	});
});
