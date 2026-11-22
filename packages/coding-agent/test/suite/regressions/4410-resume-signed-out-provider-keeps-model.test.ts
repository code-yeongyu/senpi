import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { formatNoApiKeyFoundMessage } from "../../../src/core/auth-guidance.ts";
import { estimateTokens } from "../../../src/core/compaction/compaction.ts";
import { restoreModelFromSession } from "../../../src/core/model-resolver.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { createModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";

/**
 * senpi#4410 (user report code-yeongyu/oh-my-openagent#11416): a session saved on a model that still
 * exists, but whose provider is signed out, came back on another provider's model with a smaller
 * window and no model_change. Every resume entry point must keep the saved model and leave the
 * login guidance to the first prompt.
 */

// An env-reference key that is never set, so the provider is registered but has no credentials.
const SIGNED_OUT_KEY_ENV = "SENPI_TEST_4410_SIGNED_OUT_KEY";
const SAVED = { provider: "lab-signed-out", id: "claude-opus-5-5", contextWindow: 1_000_000 };
const REPLACEMENT = { provider: "lab-signed-in", id: "gpt-5.6-luna", contextWindow: 272_000 };
// A saved direct-Anthropic model whose only signed-in lane is the subscription (senpi#3259).
const SAVED_ANTHROPIC = { provider: "anthropic", id: "claude-opus-5-5" };
const SUBSCRIPTION_LANE = "anthropic-subscription";
const LIVE_CONTEXT_TOKENS = 586_000;
const TURNS = 20;

function catalogModel(id: string, contextWindow: number) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		contextWindow,
		maxTokens: 32_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const MODELS_JSON = {
	providers: {
		[SAVED.provider]: {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey: `$${SIGNED_OUT_KEY_ENV}`,
			models: [catalogModel(SAVED.id, SAVED.contextWindow)],
		},
		[REPLACEMENT.provider]: {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey: "faux-key",
			models: [catalogModel(REPLACEMENT.id, REPLACEMENT.contextWindow)],
		},
		[SAVED_ANTHROPIC.provider]: {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey: `$${SIGNED_OUT_KEY_ENV}`,
			models: [catalogModel(SAVED_ANTHROPIC.id, SAVED.contextWindow)],
		},
		[SUBSCRIPTION_LANE]: {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey: "faux-key",
			models: [catalogModel(SAVED_ANTHROPIC.id, SAVED.contextWindow)],
		},
	},
};

// The signed-in provider is also the settings default, so the replacement an automatic pick would
// make is deterministic and has the smaller window.
const SETTINGS = { defaultProvider: REPLACEMENT.provider, defaultModel: REPLACEMENT.id };

interface Fixture {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionPath: string;
}

function seedSession(scratch: string): Fixture {
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(MODELS_JSON));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(SETTINGS));

	const sessionManager = SessionManager.create(cwd, join(scratch, "sessions"));
	sessionManager.appendModelChange(SAVED.provider, SAVED.id);
	const unit = "restored context ";
	const unitTokens =
		estimateTokens({ role: "user", content: [{ type: "text", text: unit.repeat(1_000) }], timestamp: 0 }) / 1_000;
	const text = unit.repeat(Math.ceil(LIVE_CONTEXT_TOKENS / (TURNS * 2) / unitTokens));
	let timestamp = 1;
	for (let turn = 0; turn < TURNS; turn++) {
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: timestamp++ });
		sessionManager.appendMessage({
			...fauxAssistantMessage(text, { timestamp: timestamp++ }),
			api: "openai-completions",
			provider: SAVED.provider,
			model: SAVED.id,
		});
	}
	const liveTokens = sessionManager
		.buildSessionContext()
		.messages.reduce((total, message) => total + estimateTokens(message), 0);
	expect(liveTokens).toBeGreaterThan(REPLACEMENT.contextWindow);
	expect(liveTokens).toBeGreaterThan(LIVE_CONTEXT_TOKENS - 10_000);
	expect(liveTokens).toBeLessThan(LIVE_CONTEXT_TOKENS + 10_000);
	const sessionPath = sessionManager.getSessionFile();
	if (!sessionPath) throw new Error("expected a persisted session file");
	return { cwd, agentDir, sessionManager, sessionPath };
}

async function catalogRuntime(fixture: Fixture) {
	const registry = await createModelRegistry(AuthStorage.inMemory(), join(fixture.agentDir, "models.json"));
	return { registry, runtime: getModelRuntime(registry) };
}

interface Resumed {
	model: Model<string> | undefined;
	fallbackMessage: string | undefined;
	session?: AgentSession;
	close(): Promise<void>;
}

const ENTRY_POINTS: ReadonlyArray<readonly [string, (fixture: Fixture) => Promise<Resumed>]> = [
	[
		"createAgentSession (CLI --continue/--resume, interactive /resume)",
		async (fixture) => {
			const { registry, runtime } = await catalogRuntime(fixture);
			const created = await createAgentSession({
				cwd: fixture.cwd,
				agentDir: fixture.agentDir,
				modelRuntime: runtime,
				modelRegistry: registry,
				settingsManager: SettingsManager.inMemory(SETTINGS),
				sessionManager: fixture.sessionManager,
				resourceLoader: createTestResourceLoader(),
			});
			return {
				model: created.session.model,
				fallbackMessage: created.modelFallbackMessage,
				session: created.session,
				close: async () => created.session.dispose(),
			};
		},
	],
	[
		"RPC host open_session { sessionPath } (desktop resume)",
		async (fixture) => {
			const parsed = parseArgs(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]);
			const registry = new RpcSessionRegistry({
				agentDir: fixture.agentDir,
				createRuntime: createCliRuntimeFactory(
					{ parsed, cwd: fixture.cwd, agentDir: fixture.agentDir, appMode: "rpc" },
					{ startupSettingsManager: SettingsManager.create(fixture.cwd, fixture.agentDir) },
				),
			});
			const opened = await registry.openSession({ cwd: fixture.cwd, sessionPath: fixture.sessionPath });
			const runtime = registry.getForCommand(opened.sessionId, "get_state").runtime;
			if (!runtime) throw new Error("session runtime missing");
			return {
				model: runtime.session.model,
				fallbackMessage: runtime.modelFallbackMessage,
				session: runtime.session,
				close: () => registry.close(opened.sessionId),
			};
		},
	],
	[
		"restoreModelFromSession",
		async (fixture) => {
			const { runtime } = await catalogRuntime(fixture);
			const restored = await restoreModelFromSession(SAVED.provider, SAVED.id, undefined, false, runtime);
			return { ...restored, close: async () => {} };
		},
	],
	[
		"restoreModelFromSession with a current model",
		async (fixture) => {
			const { runtime } = await catalogRuntime(fixture);
			const current = runtime.getModel(REPLACEMENT.provider, REPLACEMENT.id);
			const restored = await restoreModelFromSession(SAVED.provider, SAVED.id, current, false, runtime);
			return { ...restored, close: async () => {} };
		},
	],
];

describe("resume keeps a saved model whose provider is signed out (senpi#4410, omo#11416)", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "senpi-4410-"));
		vi.stubEnv("SENPI_CODING_AGENT_DIR", join(scratch, "agent"));
		vi.stubEnv("OMO_CODING_AGENT_DIR", join(scratch, "agent"));
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("SENPI_OFFLINE", "1");
		for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) {
			vi.stubEnv(name, undefined);
		}
		expect(process.env[SIGNED_OUT_KEY_ENV]).toBeUndefined();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(scratch, { recursive: true, force: true });
	});

	it.each(ENTRY_POINTS)(
		"%s keeps the saved model, switches nothing, and the first prompt asks for a login",
		async (_name, resume) => {
			const fixture = seedSession(scratch);
			const resumed = await resume(fixture);
			try {
				expect({ provider: resumed.model?.provider, id: resumed.model?.id }).toEqual({
					provider: SAVED.provider,
					id: SAVED.id,
				});
				expect(resumed.fallbackMessage).toBeUndefined();
				const session = resumed.session;
				if (!session) return;

				const branch = session.sessionManager.getBranch();
				expect(branch.filter((entry) => entry.type === "model_change" && entry.modelId !== SAVED.id)).toEqual([]);
				expect(branch.filter((entry) => entry.type === "compaction")).toEqual([]);
				expect(session.agent.state.messages).toHaveLength(TURNS * 2);

				await expect(session.prompt("continue")).rejects.toThrow(formatNoApiKeyFoundMessage(SAVED.provider));
				expect(session.model?.provider).toBe(SAVED.provider);
				expect(session.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
			} finally {
				await resumed.close();
			}
		},
		60_000,
	);

	it("createAgentSession keeps a saved anthropic model when only the subscription lane is signed in", async () => {
		const fixture = seedSession(scratch);
		fixture.sessionManager.appendModelChange(SAVED_ANTHROPIC.provider, SAVED_ANTHROPIC.id);
		const modelChangesBefore = fixture.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "model_change").length;
		const resumed = await ENTRY_POINTS[0][1](fixture);
		try {
			expect({ provider: resumed.model?.provider, id: resumed.model?.id }).toEqual(SAVED_ANTHROPIC);
			expect(resumed.fallbackMessage).toBeUndefined();
			const modelChanges = fixture.sessionManager.getBranch().filter((entry) => entry.type === "model_change");
			expect(modelChanges).toHaveLength(modelChangesBefore);
			expect(modelChanges.at(-1)).toMatchObject({ provider: SAVED_ANTHROPIC.provider, modelId: SAVED_ANTHROPIC.id });
		} finally {
			await resumed.close();
		}
	}, 60_000);

	it("still substitutes when the saved model is gone from the catalog", async () => {
		const fixture = seedSession(scratch);
		fixture.sessionManager.appendModelChange(SAVED.provider, "retired-model");
		const resumed = await ENTRY_POINTS[0][1](fixture);
		try {
			expect(resumed.model?.provider).toBe(REPLACEMENT.provider);
			expect(resumed.fallbackMessage).toContain(`Could not restore model ${SAVED.provider}/retired-model`);
		} finally {
			await resumed.close();
		}
	}, 60_000);
});
