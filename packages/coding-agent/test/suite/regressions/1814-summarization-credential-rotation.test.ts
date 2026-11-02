import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";

// senpi#1814 / senpi#1556: session title generation and compaction resolved one credential up front and
// sent it as an explicit key, which switches credential rotation off. They must select the account the
// way the main turn does: the pinned account here, never the stored top-level key.

const API: Api = "openai-completions";
const PROVIDER = "pool-fixture";

const model: Model<Api> = {
	id: "pool-model",
	name: "Pool Model",
	api: API,
	provider: PROVIDER,
	baseUrl: "https://pool.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: API,
		provider: PROVIDER,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface Attempt {
	kind: "title" | "summary" | "turn";
	apiKey: string;
}

describe("summarization requests select credentials like the main turn (senpi#1814, senpi#1556)", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-1814-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function pinnedPoolSession(autoTitleSessions: boolean) {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(PROVIDER, async () => ({
			type: "api_key",
			key: "key-spent-default",
			pinned: "work",
			accounts: [
				{ name: "default", key: "key-spent-default", source: "login" },
				{ name: "work", key: "key-work", source: "login" },
			],
		}));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const attempts: Attempt[] = [];
		const respond = (context: Context, apiKey: string | undefined) => {
			const systemPrompt = getCurrentSystemPrompt(normalizeContext(context).messages);
			const last = context.messages.at(-1);
			const lastText = last && Array.isArray(last.content) ? JSON.stringify(last.content) : String(last?.content);
			const kind: Attempt["kind"] = systemPrompt.includes("<title>")
				? "title"
				: /summar/i.test(lastText)
					? "summary"
					: "turn";
			attempts.push({ kind, apiKey: apiKey ?? "missing" });
			const message = assistant(kind === "title" ? "<title>Pinned Account</title>" : "## Goal\nok");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } } satisfies AssistantMessageEvent);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		modelRegistry.registerProvider(PROVIDER, {
			api: API,
			streamSimple: (_model, context, options) => respond(context, options?.apiKey),
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			sessionManager: SessionManager.inMemory(cwd),
			autoTitleSessions,
		});
		return { session, attempts };
	}

	it("sends the session title request with the pinned account's key", async () => {
		const { session, attempts } = await pinnedPoolSession(true);
		try {
			const named = new Promise<void>((resolve) => {
				const unsubscribe = session.subscribe((event) => {
					if (event.type !== "session_info_changed") return;
					unsubscribe();
					resolve();
				});
			});
			await session.prompt("rename the pinned account in the settings page");
			await named;
		} finally {
			session.dispose();
		}
		expect(attempts.filter((attempt) => attempt.kind === "turn").map((attempt) => attempt.apiKey)).toEqual([
			"key-work",
		]);
		expect(attempts.filter((attempt) => attempt.kind === "title").map((attempt) => attempt.apiKey)).toEqual([
			"key-work",
		]);
	});

	it("sends the compaction summary request with the pinned account's key", async () => {
		const { session, attempts } = await pinnedPoolSession(false);
		try {
			await session.prompt("first task");
			await session.prompt("second task");
			await session.compact();
		} finally {
			session.dispose();
		}
		const summaries = attempts.filter((attempt) => attempt.kind !== "turn");
		expect(attempts.filter((attempt) => attempt.kind === "turn").map((attempt) => attempt.apiKey)).toEqual([
			"key-work",
			"key-work",
		]);
		expect(summaries.length).toBeGreaterThan(0);
		expect(summaries.map((attempt) => attempt.apiKey)).toEqual(summaries.map(() => "key-work"));
	});
});
