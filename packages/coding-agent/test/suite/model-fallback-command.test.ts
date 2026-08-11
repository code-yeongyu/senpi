import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import modelFallbackExtension, {
	isModelFallbackDisabled,
} from "../../src/core/extensions/builtin/model-fallback/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type { ExtensionCommandContext, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";

const dirs: string[] = [];
let previousAgentDir: string | undefined;
const primary = model("anthropic", "claude-fable-5", true);
const fallback = model("ccapi", "kimi-k3", true);
const kimiK3 = model("kimi-coding", "k3", true);
const sdkFable = model("claude-sdk-oauth", "claude-fable-5", true);
const sdkOpus5 = model("claude-sdk-oauth", "claude-opus-5", true);
const opus5 = model("anthropic", "claude-opus-5", true);
const opus48 = model("anthropic", "claude-opus-4-8", true);

type Command = {
	description?: string;
	argumentHint?: string;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

function model(provider: string, id: string, reasoning: boolean): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "faux",
		baseUrl: "https://models.example.test/v1",
		reasoning,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text"],
		contextWindow: 1,
		maxTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

async function harness(): Promise<Map<string, Command>> {
	const extension = await loadExtensionFromFactory(
		modelFallbackExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
	);
	return new Map(extension.commands);
}

function createUi(notices: string[], choices: string[]): ExtensionUIContext {
	return {
		select: async () => choices.shift(),
		confirm: async () => false,
		input: async () => undefined,
		notify: (message: string) => notices.push(message),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>(): Promise<T> => {
			throw new Error("Fallback command tests do not render custom UI");
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function createModelRegistry(
	registeredModels: Model<Api>[] = [primary, fallback],
	availableModels: Model<Api>[] = registeredModels,
): ModelRegistry {
	const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
	modelRegistry.getAll = () => registeredModels;
	modelRegistry.getAvailable = () => availableModels;
	modelRegistry.find = (provider: string, id: string) =>
		registeredModels.find((registeredModel) => registeredModel.provider === provider && registeredModel.id === id);
	return modelRegistry;
}

async function context(
	dir: string,
	notices: string[],
	choices: string[] = [],
	registeredModels?: Model<Api>[],
	availableModels?: Model<Api>[],
): Promise<ExtensionCommandContext> {
	const settings = SettingsManager.create(dir);
	const modelRegistry = createModelRegistry(registeredModels, availableModels ?? registeredModels);
	return {
		ui: createUi(notices, choices),
		mode: choices.length > 0 ? "tui" : "print",
		hasUI: choices.length > 0,
		cwd: dir,
		agentDir: dir,
		sessionManager: SessionManager.inMemory(),
		modelRegistry,
		model: undefined,
		serviceTier: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		getLookAtSettings: () => ({ enabled: true, models: undefined }),
		getImageSettings: () => ({ autoResize: true, blockImages: false }),
		sessionSettings: {
			getRetryFallbackSettings: () => settings.getRetryFallbackSettings(),
			setFallbackChain: async (key: string, entries: readonly string[]) => {
				settings.setFallbackChain(key, [...entries]);
				await settings.flush();
			},
			removeFallbackChain: async (key: string) => {
				settings.removeFallbackChain(key);
				await settings.flush();
			},
			setModelFallbackEnabled: async (enabled: boolean) => {
				settings.setModelFallbackEnabled(enabled);
				await settings.flush();
			},
			setFallbackRevertPolicy: async (policy: "cooldown-expiry" | "never") => {
				settings.setFallbackRevertPolicy(policy);
				await settings.flush();
			},
			reload: () => settings.reload(),
			getFallbackStatus: () => undefined,
		},
		compact: () => {},
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd: dir }),
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	};
}

describe("model fallback builtin command", () => {
	beforeEach(async () => {
		previousAgentDir = process.env.SENPI_CODING_AGENT_DIR;
		const agentDir = await mkdtemp(join(tmpdir(), "senpi-fallback-agent-"));
		dirs.push(agentDir);
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
	});
	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = previousAgentDir;
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("registers /fallback with its quick-set hint", async () => {
		const command = (await harness()).get("fallback");
		expect(command?.argumentHint).toBe("[target [fallback1 fallback2 ...]]");
		expect(command?.description).toContain("fallback");
	});

	it("lists a default chain only for models the user can actually select", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-fallback-command-"));
		dirs.push(dir);
		const notices: string[] = [];
		const catalogOnly = model("github-copilot", "claude-fable-5", true);
		// The builtin catalog publishes Fable 5 under many providers; only the SDK
		// OAuth one is actually usable here, so only its chain belongs on screen.
		const ctx = await context(
			dir,
			notices,
			["Show chains & live state"],
			[sdkFable, sdkOpus5, kimiK3, catalogOnly],
			[sdkFable, sdkOpus5, kimiK3],
		);

		await (await harness()).get("fallback")?.handler("", ctx);

		const rendered = notices.join("\n");
		expect(rendered).toContain("claude-sdk-oauth/claude-fable-5 -> kimi-coding/k3:max");
		expect(rendered).not.toContain("github-copilot/claude-fable-5 ->");
	});

	it("quick-set validates and persists a chain visible after a session-side reload", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-fallback-command-"));
		dirs.push(dir);
		const notices: string[] = [];
		const command = (await harness()).get("fallback");
		const sessionSideSettings = SettingsManager.create(dir);
		await command?.handler("anthropic/claude-fable-5 ccapi/kimi-k3:max", await context(dir, notices));
		await sessionSideSettings.reload();
		// The user's canonical key wins for that provider; the bare shipped default
		// stays in the raw map so other providers serving the family keep a chain.
		expect(sessionSideSettings.getRetryFallbackSettings().chains["anthropic/claude-fable-5"]).toEqual([
			"ccapi/kimi-k3:max",
		]);
		expect(notices).toContain("Fallback chain saved for anthropic/claude-fable-5.");
	});

	it("rejects an invalid quick-set without writing settings", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-fallback-command-"));
		dirs.push(dir);
		const notices: string[] = [];
		await (await harness()).get("fallback")?.handler("bogus/model nope", await context(dir, notices));
		expect(SettingsManager.create(dir).getGlobalSettings().retry).toBeUndefined();
		expect(notices.join("\n")).toContain("not a valid or known model selector");
	});

	it("maps the CLI flag and environment escape hatch to a disabled run override", () => {
		expect(isModelFallbackDisabled(true, {})).toBe(true);
		expect(isModelFallbackDisabled(false, { SENPI_NO_FALLBACK: "1" })).toBe(true);
		expect(isModelFallbackDisabled(false, {})).toBe(false);
	});

	it.each([
		{
			name: "all default models are available",
			models: [primary, kimiK3, opus5, opus48],
			expected:
				"anthropic/claude-fable-5 -> kimi-coding/k3:max, anthropic/claude-opus-5:xhigh, anthropic/claude-opus-4-8:xhigh",
		},
		{
			name: "Fable 5 is attached through the Claude SDK OAuth provider instead of anthropic",
			models: [sdkFable, kimiK3, sdkOpus5],
			expected: "claude-sdk-oauth/claude-fable-5 -> kimi-coding/k3:max, claude-sdk-oauth/claude-opus-5:xhigh",
		},
		{
			name: "Kimi K3 is unavailable",
			models: [primary, opus5, opus48],
			expected: "anthropic/claude-fable-5 -> anthropic/claude-opus-5:xhigh, anthropic/claude-opus-4-8:xhigh",
		},
		{
			name: "Fable 5 is unavailable",
			models: [opus5, opus48],
			expected: "No fallback chains configured.",
		},
	])("shows the availability-filtered default chain when $name", async ({ models, expected }) => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-fallback-command-"));
		dirs.push(dir);
		const notices: string[] = [];
		const choices = ["Show chains & live state"];

		await (await harness()).get("fallback")?.handler("", await context(dir, notices, choices, models));

		expect(notices.join("\n")).toContain(expected);
	});

	it("handles a headless menu invocation cleanly", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-fallback-command-"));
		dirs.push(dir);
		const notices: string[] = [];
		await (await harness()).get("fallback")?.handler("", await context(dir, notices));
		expect(notices).toContain("Fallback menu requires interactive UI. Use /fallback <target> <fallback...>.");
	});
});
