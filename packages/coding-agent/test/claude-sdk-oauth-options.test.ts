import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { resetPresetAppendDeprecation } from "../src/core/extensions/builtin/claude-sdk-oauth/guidance.ts";
import {
	buildClaudeSdkOauthQueryOptions,
	type ClaudeSdkOauthAuthLane,
} from "../src/core/extensions/builtin/claude-sdk-oauth/options.ts";
import {
	loadClaudeSdkOauthProviderSettings,
	resolveSystemPromptMode,
} from "../src/core/extensions/builtin/claude-sdk-oauth/settings.ts";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../src/core/settings-manager.ts";

const temporaryDirectories: string[] = [];
const DYNAMIC_BOUNDARY_SENTINEL = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

function expectNoDynamicBoundarySentinel(systemPrompt: unknown): void {
	expect(JSON.stringify(systemPrompt)).not.toContain(DYNAMIC_BOUNDARY_SENTINEL);
}

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-claude-sdk-oauth-options-"));
	temporaryDirectories.push(directory);
	return directory;
}

function model(id = "claude-sonnet-4-6"): Model<Api> {
	return {
		id,
		name: id,
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		baseUrl: "claude-sdk-oauth",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

function context(systemPrompt?: string): Context {
	return { messages: [], systemPrompt };
}

function optionsFor(
	providerSettings: Parameters<typeof buildClaudeSdkOauthQueryOptions>[0]["providerSettings"],
	authLane: ClaudeSdkOauthAuthLane = "ambient",
	cwd = temporaryDirectory(),
) {
	return buildClaudeSdkOauthQueryOptions({ model: model(), context: context(), cwd, providerSettings, authLane });
}

function layeredSettings(global: unknown = {}, project: unknown = {}): SettingsManager {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ claudeSdkOauthProvider: global }));
	storage.withLock("project", () => JSON.stringify({ claudeSdkOauthProvider: project }));
	return SettingsManager.fromStorage(storage);
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Claude SDK OAuth provider settings", () => {
	it.each([
		[{ systemPromptMode: "override" as const }, { mode: "override", source: "setting", conflict: false }],
		[{ appendSystemPrompt: false }, { mode: "preset-append", source: "legacy", conflict: false }],
		[{ appendSystemPrompt: true }, { mode: "full", source: "legacy", conflict: false }],
		[{}, { mode: "full", source: "default", conflict: false }],
	])("resolves the system prompt mode matrix", (settings, expected) => {
		expect(resolveSystemPromptMode(settings)).toEqual(expected);
	});

	it("lets the explicit mode win while reporting a legacy-key conflict", () => {
		expect(resolveSystemPromptMode({ systemPromptMode: "full", appendSystemPrompt: false })).toEqual({
			mode: "full",
			source: "setting",
			conflict: true,
		});
	});

	it("drops invalid values for every new provider parser", () => {
		const settings = layeredSettings({
			systemPromptMode: "append",
			systemPromptFile: "",
			resumeMode: "yes",
		});
		expect(loadClaudeSdkOauthProviderSettings(settings, {})).toEqual({});
	});

	it.each([
		["systemPromptMode", "SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE", "preset-append", "full", "override", "bad"],
		["systemPromptFile", "SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_FILE", "global.md", "project.md", "env.md", ""],
		["resumeMode", "SENPI_CLAUDE_SDK_OAUTH_RESUME", "auto", "off", "auto", "bad"],
		["tokenInjection", "SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION", "ambient", "config-dir", "oauth-slots", "bad"],
		["settingSources", "SENPI_CLAUDE_SDK_OAUTH_SETTING_SOURCES", ["user"], ["project"], "local,user", "bad"],
		["pinnedAccount", "SENPI_CLAUDE_SDK_OAUTH_PINNED_ACCOUNT", "global", "project", "env", ""],
	] as const)("applies env > project > global > default for %s", (key, envName, global, project, env, invalid) => {
		const manager = layeredSettings({ [key]: global }, { [key]: project });
		const expectedEnv = key === "settingSources" ? ["local", "user"] : env;
		expect(loadClaudeSdkOauthProviderSettings(manager, { [envName]: env })[key]).toEqual(expectedEnv);
		expect(loadClaudeSdkOauthProviderSettings(manager, { [envName]: invalid })[key]).toEqual(project);
		expect(loadClaudeSdkOauthProviderSettings(manager, {})[key]).toEqual(project);
		expect(loadClaudeSdkOauthProviderSettings(layeredSettings({ [key]: global }), {})[key]).toEqual(global);
		expect(loadClaudeSdkOauthProviderSettings(layeredSettings(), {})[key]).toBeUndefined();
	});

	it("tracks env as the source of an env-selected prompt mode", () => {
		const settings = loadClaudeSdkOauthProviderSettings(layeredSettings(), {
			SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE: "override",
		});
		expect(resolveSystemPromptMode(settings)).toEqual({ mode: "override", source: "env", conflict: false });
	});

	it("accepts an empty env setting-sources list", () => {
		expect(
			loadClaudeSdkOauthProviderSettings(layeredSettings(), { SENPI_CLAUDE_SDK_OAUTH_SETTING_SOURCES: "" }),
		).toEqual({
			settingSources: [],
		});
	});
});

describe("preset-append deprecation warning in buildClaudeSdkOauthQueryOptions", () => {
	it("surfaces the deprecation warning via onGuidance for preset-append mode", () => {
		resetPresetAppendDeprecation();
		const warnings: string[] = [];
		buildClaudeSdkOauthQueryOptions({
			model: model(),
			context: context(),
			cwd: temporaryDirectory(),
			providerSettings: { systemPromptMode: "preset-append" },
			sessionId: "deprecation-prod-1",
			onGuidance: (text) => warnings.push(text),
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("deprecated");
		expect(warnings[0]).toContain("preset-append");
	});

	it("surfaces the conflict warning via onGuidance when both keys are set", () => {
		resetPresetAppendDeprecation();
		const warnings: string[] = [];
		buildClaudeSdkOauthQueryOptions({
			model: model(),
			context: context(),
			cwd: temporaryDirectory(),
			providerSettings: { systemPromptMode: "preset-append", appendSystemPrompt: false },
			sessionId: "conflict-prod-1",
			onGuidance: (text) => warnings.push(text),
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("systemPromptMode");
		expect(warnings[0]).toContain("wins");
	});

	it("does not emit a warning in full mode", () => {
		resetPresetAppendDeprecation();
		const warnings: string[] = [];
		buildClaudeSdkOauthQueryOptions({
			model: model(),
			context: context(),
			cwd: temporaryDirectory(),
			providerSettings: { systemPromptMode: "full" },
			sessionId: "full-prod-1",
			onGuidance: (text) => warnings.push(text),
		});
		expect(warnings).toHaveLength(0);
	});

	it("suppresses the warning once per session across multiple calls", () => {
		resetPresetAppendDeprecation();
		const warnings: string[] = [];
		const cwd = temporaryDirectory();
		buildClaudeSdkOauthQueryOptions({
			model: model(),
			context: context(),
			cwd,
			providerSettings: { systemPromptMode: "preset-append" },
			sessionId: "suppress-prod-1",
			onGuidance: (text) => warnings.push(text),
		});
		buildClaudeSdkOauthQueryOptions({
			model: model(),
			context: context(),
			cwd,
			providerSettings: { systemPromptMode: "preset-append" },
			sessionId: "suppress-prod-1",
			onGuidance: (text) => warnings.push(text),
		});
		buildClaudeSdkOauthQueryOptions({
			model: model(),
			context: context(),
			cwd,
			providerSettings: { systemPromptMode: "preset-append" },
			sessionId: "suppress-prod-2",
			onGuidance: (text) => warnings.push(text),
		});
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("deprecated");
		expect(warnings[1]).toContain("deprecated");
	});
});

describe("Claude SDK OAuth query options", () => {
	it("pins native auto-compaction when provider settings omit compaction preferences", () => {
		const queryOptions = optionsFor({});

		expect(queryOptions.settings).toEqual({ autoCompactEnabled: true });
	});

	it("keeps preset-append as the Claude Code preset with the three extracted blocks joined", () => {
		const cwd = temporaryDirectory();
		writeFileSync(join(cwd, "AGENTS.md"), "Use the senpi workspace.");
		const skills =
			"The following skills provide specialized instructions for specific tasks.\n<available_skills>\n<skill>deploy</skill>\n</available_skills>";
		const rules =
			"<!--senpi:project-rules:1:start-->\n<project_rules>\n## Project Instructions\nShip carefully.\n</project_rules>\n<!--senpi:project-rules:1:end-->";
		const queryOptions = buildClaudeSdkOauthQueryOptions({
			model: model(),
			cwd,
			context: context(`before\n${skills}\n${rules}\nafter`),
			providerSettings: { systemPromptMode: "preset-append" },
		});

		expect(queryOptions.systemPrompt).toEqual({
			type: "preset",
			preset: "claude_code",
			append: [
				"# CLAUDE.md\n\nUse the environment workspace.",
				skills,
				rules.slice(rules.indexOf("<project_rules>"), rules.indexOf("</project_rules>") + 16),
			].join("\n\n"),
		});
		expectNoDynamicBoundarySentinel(queryOptions.systemPrompt);
	});

	it("delivers full prompts verbatim as a string with no preset descriptor", () => {
		const systemPrompt =
			"stable\nCurrent date: decoy\nstill stable\nCurrent date: 2026-07-31\nCurrent working directory: /repo";
		const queryOptions = buildClaudeSdkOauthQueryOptions({
			model: model(),
			context: context(systemPrompt),
			cwd: temporaryDirectory(),
			providerSettings: { systemPromptMode: "full" },
		});

		expect(queryOptions.systemPrompt).toBe(systemPrompt);
		expect(typeof queryOptions.systemPrompt).toBe("string");
		expectNoDynamicBoundarySentinel(queryOptions.systemPrompt);
	});

	it("delivers a full prompt without a Current date marker verbatim", () => {
		const queryOptions = buildClaudeSdkOauthQueryOptions({
			model: model(),
			context: context("custom prompt without the dynamic marker"),
			cwd: temporaryDirectory(),
			providerSettings: { systemPromptMode: "full" },
		});

		expect(queryOptions.systemPrompt).toBe("custom prompt without the dynamic marker");
		expectNoDynamicBoundarySentinel(queryOptions.systemPrompt);
	});

	it("loads override prompt contents verbatim as a string with no preset descriptor", () => {
		const cwd = temporaryDirectory();
		const promptFile = join(cwd, "override.md");
		const overridePrompt = "override static\nCurrent date: per turn";
		writeFileSync(promptFile, overridePrompt);
		const queryOptions = optionsFor({ systemPromptMode: "override", systemPromptFile: promptFile }, "ambient", cwd);

		expect(queryOptions.systemPrompt).toBe(overridePrompt);
		expect(typeof queryOptions.systemPrompt).toBe("string");
		expectNoDynamicBoundarySentinel(queryOptions.systemPrompt);
	});

	it("throws actionable guidance when an override file is missing", () => {
		const missing = join(temporaryDirectory(), "missing-prompt.md");
		expect(() => optionsFor({ systemPromptMode: "override", systemPromptFile: missing })).toThrow(
			expect.objectContaining({ message: expect.stringContaining(missing) }),
		);
		expect(() => optionsFor({ systemPromptMode: "override" })).toThrow(/systemPromptFile/);
	});

	it.each(["ambient", "oauth-slots"] as const)(
		"defaults full and override settingSources to [] on the %s lane",
		(authLane) => {
			expect(optionsFor({ systemPromptMode: "full" }, authLane).settingSources).toEqual([]);
			const cwd = temporaryDirectory();
			const promptFile = join(cwd, "override.md");
			writeFileSync(promptFile, "override");
			expect(
				optionsFor({ systemPromptMode: "override", systemPromptFile: promptFile }, authLane, cwd).settingSources,
			).toEqual([]);
		},
	);

	it.each([
		["ambient", ["user", "project"]],
		["oauth-slots", []],
	] as const)("keeps the preset-append settingSources matrix on the %s lane", (authLane, expected) => {
		expect(optionsFor({ systemPromptMode: "preset-append" }, authLane).settingSources).toEqual(expected);
	});

	it.each(["full", "override", "preset-append"] as const)(
		"lets explicit settingSources win in %s mode on every lane",
		(systemPromptMode) => {
			const cwd = temporaryDirectory();
			const promptFile = join(cwd, "override.md");
			writeFileSync(promptFile, "override");
			for (const authLane of ["ambient", "oauth-slots"] as const) {
				expect(
					optionsFor({ systemPromptMode, systemPromptFile: promptFile, settingSources: ["local"] }, authLane, cwd)
						.settingSources,
				).toEqual(["local"]);
			}
		},
	);

	it("preserves strict MCP defaults for the legacy disabled-append setting", () => {
		expect(optionsFor({ appendSystemPrompt: false }).extraArgs).toEqual({ "strict-mcp-config": null });
		expect(optionsFor({ systemPromptMode: "full", strictMcpConfig: true }).extraArgs).toEqual({
			"strict-mcp-config": null,
		});
	});

	it.each([
		["minimal", "low"],
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
		["xhigh", "max"],
		["max", "max"],
	] as const)("maps adaptive %s reasoning to %s effort", (reasoning, effort) => {
		const queryOptions = buildClaudeSdkOauthQueryOptions({
			model: model(),
			context: context(),
			cwd: temporaryDirectory(),
			providerSettings: {},
			streamOptions: { reasoning },
		});

		expect(queryOptions.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(queryOptions.effort).toBe(effort);
		expect(queryOptions.maxThinkingTokens).toBeUndefined();
	});

	it("uses a caller budget for unsupported adaptive-thinking models", () => {
		const queryOptions = buildClaudeSdkOauthQueryOptions({
			model: model("claude-sonnet-4-5"),
			context: context(),
			cwd: temporaryDirectory(),
			providerSettings: {},
			streamOptions: { reasoning: "high", thinkingBudgets: { high: 7_777 } },
		});

		expect(queryOptions.thinking).toBeUndefined();
		expect(queryOptions.effort).toBeUndefined();
		expect(queryOptions.maxThinkingTokens).toBe(7_777);
	});

	it("falls back to defaults when the provider settings block is malformed", () => {
		const malformed: Settings & { claudeSdkOauthProvider: unknown } = {
			claudeSdkOauthProvider: {
				appendSystemPrompt: "false",
				settingSources: ["user", "gateway"],
				strictMcpConfig: "true",
				pinnedAccount: 7,
				tokenInjection: "unmanaged",
			},
		};
		const providerSettings = loadClaudeSdkOauthProviderSettings(SettingsManager.inMemory(malformed));
		const queryOptions = optionsFor(providerSettings);

		expect(providerSettings).toEqual({});
		expect(queryOptions.settingSources).toEqual([]);
		expect(queryOptions.extraArgs).toBeUndefined();
	});

	it("does not pass hostile user settings into an append-mode child", () => {
		const sandboxHome = temporaryDirectory();
		const hostileSettings = join(sandboxHome, ".claude", "settings.json");
		mkdirSync(join(sandboxHome, ".claude"));
		writeFileSync(
			hostileSettings,
			JSON.stringify({
				apiKeyHelper: "leak-a-token",
				env: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BASE_URL: "https://gateway.invalid" },
			}),
		);
		const queryOptions = optionsFor({ appendSystemPrompt: true });

		expect(queryOptions.settingSources).toEqual([]);
		expect(JSON.stringify(queryOptions)).not.toContain("leak-a-token");
		expect(JSON.stringify(queryOptions)).not.toContain("gateway.invalid");
	});
});
