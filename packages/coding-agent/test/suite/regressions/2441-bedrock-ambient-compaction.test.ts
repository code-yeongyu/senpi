import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	createSpeculativeCompactionSnapshot,
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../../src/core/extensions/builtin/compaction/speculative.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../../model-runtime-test-utils.ts";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	sendCalls: 0,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<unknown> {
			bedrockMock.sendCalls++;
			return Promise.resolve({
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ambient summary" } } };
					yield { contentBlockStop: { contentBlockIndex: 0 } };
					yield { messageStop: { stopReason: "end_turn" } };
				})(),
			});
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

const tempDirectories: string[] = [];

function createContext(model: Model<any>, modelRegistry: Awaited<ReturnType<typeof createInMemoryModelRegistry>>) {
	const sessionManager = SessionManager.inMemory();
	const history = "history ".repeat(12_000);
	sessionManager.appendMessage({ role: "user", content: history, timestamp: Date.now() - 3_000 });
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: history }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 50_000,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 50_001,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now() - 2_000,
	});
	sessionManager.appendMessage({ role: "user", content: "latest request", timestamp: Date.now() - 1_000 });
	const context: SpeculativeCompactionContext = {
		model,
		modelRegistry,
		sessionManager,
		getContextUsage: () => ({ tokens: 50_000, contextWindow: model.contextWindow, percent: 25 }),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 1, keepRecentTokens: 1 }),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
	const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
	if (!snapshot) throw new Error("expected a compaction snapshot");
	return { context, snapshot };
}

describe("issue #2441 Bedrock ambient auth compaction", () => {
	beforeEach(() => {
		bedrockMock.constructorCalls.length = 0;
		bedrockMock.sendCalls = 0;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("reaches the Bedrock summary request with only an ambient AWS profile", async () => {
		const awsDirectory = mkdtempSync(join(tmpdir(), "senpi-2441-aws-"));
		tempDirectories.push(awsDirectory);
		const credentialsFile = join(awsDirectory, "credentials");
		writeFileSync(
			credentialsFile,
			"[fixture-profile]\naws_access_key_id = fixture\naws_secret_access_key = fixture\n",
		);
		vi.stubEnv("AWS_PROFILE", "fixture-profile");
		vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
		vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", undefined);
		vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);

		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const model = registry.find("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		if (!model) throw new Error("expected built-in Bedrock model");
		const { context, snapshot } = createContext(model, registry);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result?.summary).toBe("ambient summary");
		expect(bedrockMock.sendCalls).toBe(1);
		expect(bedrockMock.constructorCalls[0]?.profile).toBe("fixture-profile");
	});

	it("still rejects a provider with no resolved credential before the request", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", undefined);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected built-in Anthropic model");
		const { context, snapshot } = createContext(model, registry);

		await expect(runExtensionCompaction(context, snapshot)).rejects.toThrow(
			'summarization credentials unavailable: no credentials resolved for provider "anthropic"',
		);
		expect(bedrockMock.sendCalls).toBe(0);
	});
});
