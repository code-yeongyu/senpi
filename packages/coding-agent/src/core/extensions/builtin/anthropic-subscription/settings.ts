import { getAgentDir } from "../../../../config.ts";
import { getFileContentRevision } from "../../../../utils/paths.ts";
import { getSettingsPath, type Settings, SettingsManager } from "../../../settings-manager.ts";
import type { SettingSource } from "./sdk-boundary.ts";

export type AnthropicSubscriptionSystemPromptMode = "preset-append" | "full" | "override";
export type AnthropicSubscriptionResumeMode = "auto" | "off";
export type AnthropicSubscriptionTokenInjection = "oauth-slots" | "config-dir" | "ambient";

export interface AnthropicSubscriptionProviderSettings {
	/**
	 * Explicit opt-in for the ambient (host Claude CLI) auth lane. Absent means
	 * false: a logged-in host CLI alone never makes this provider available,
	 * because that would silently spend the user's Claude subscription. Stored
	 * accounts and `CLAUDE_CODE_OAUTH_TOKEN*` are themselves explicit opt-ins
	 * and stay available without this flag.
	 */
	readonly enabled?: boolean;
	readonly appendSystemPrompt?: boolean;
	readonly systemPromptMode?: AnthropicSubscriptionSystemPromptMode;
	readonly systemPromptFile?: string;
	readonly resumeMode?: AnthropicSubscriptionResumeMode;
	readonly settingSources?: SettingSource[];
	readonly strictMcpConfig?: boolean;
	readonly pinnedAccount?: string;
	readonly tokenInjection?: AnthropicSubscriptionTokenInjection;
}

export type ResolvedSystemPromptMode = {
	mode: AnthropicSubscriptionSystemPromptMode;
	source: string;
	conflict: boolean;
};

type SettingsWithAnthropicSubscriptionProvider = Settings & {
	// The canonical key after the provider rename (senpi#1989); the legacy key is
	// still read for two releases for settings that predate the migration.
	anthropicSubscriptionProvider?: unknown;
	claudeSdkOauthProvider?: unknown;
};

type Environment = Readonly<Record<string, string | undefined>>;

const systemPromptModeSources = new WeakMap<AnthropicSubscriptionProviderSettings, "env">();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettingSources(value: unknown): SettingSource[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (!value.every((source) => source === "user" || source === "project" || source === "local")) {
		return undefined;
	}
	return [...value];
}

function parseEnvironmentSettingSources(value: string | undefined): SettingSource[] | undefined {
	if (value === undefined) return undefined;
	if (value === "") return [];
	return parseSettingSources(value.split(",").map((source) => source.trim()));
}

function parseSystemPromptMode(value: unknown): AnthropicSubscriptionSystemPromptMode | undefined {
	return value === "preset-append" || value === "full" || value === "override" ? value : undefined;
}

function parseResumeMode(value: unknown): AnthropicSubscriptionResumeMode | undefined {
	return value === "auto" || value === "off" ? value : undefined;
}

function parseTokenInjection(value: unknown): AnthropicSubscriptionTokenInjection | undefined {
	return value === "oauth-slots" || value === "config-dir" || value === "ambient" ? value : undefined;
}

function parseEnvironmentBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	switch (value.toLowerCase()) {
		case "1":
		case "true":
			return true;
		case "0":
		case "false":
			return false;
		default:
			return undefined;
	}
}

function parseNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseProviderSettings(value: unknown): AnthropicSubscriptionProviderSettings {
	if (!isRecord(value)) return {};
	const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
	const appendSystemPrompt = typeof value.appendSystemPrompt === "boolean" ? value.appendSystemPrompt : undefined;
	const systemPromptMode = parseSystemPromptMode(value.systemPromptMode);
	const systemPromptFile = parseNonEmptyString(value.systemPromptFile);
	const resumeMode = parseResumeMode(value.resumeMode);
	const settingSources = parseSettingSources(value.settingSources);
	const strictMcpConfig = typeof value.strictMcpConfig === "boolean" ? value.strictMcpConfig : undefined;
	const pinnedAccount = parseNonEmptyString(value.pinnedAccount);
	const tokenInjection = parseTokenInjection(value.tokenInjection);
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
		...(systemPromptMode !== undefined ? { systemPromptMode } : {}),
		...(systemPromptFile !== undefined ? { systemPromptFile } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
		...(settingSources !== undefined ? { settingSources } : {}),
		...(strictMcpConfig !== undefined ? { strictMcpConfig } : {}),
		...(pinnedAccount !== undefined ? { pinnedAccount } : {}),
		...(tokenInjection !== undefined ? { tokenInjection } : {}),
	};
}

function parseEnvironmentSettings(environment: Environment): AnthropicSubscriptionProviderSettings {
	const enabled = parseEnvironmentBoolean(environment.SENPI_CLAUDE_SDK_OAUTH_ENABLED);
	const systemPromptMode = parseSystemPromptMode(environment.SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE);
	const systemPromptFile = parseNonEmptyString(environment.SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_FILE);
	const resumeMode = parseResumeMode(environment.SENPI_CLAUDE_SDK_OAUTH_RESUME);
	const tokenInjection = parseTokenInjection(environment.SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION);
	const settingSources = parseEnvironmentSettingSources(environment.SENPI_CLAUDE_SDK_OAUTH_SETTING_SOURCES);
	const pinnedAccount = parseNonEmptyString(environment.SENPI_CLAUDE_SDK_OAUTH_PINNED_ACCOUNT);
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(systemPromptMode !== undefined ? { systemPromptMode } : {}),
		...(systemPromptFile !== undefined ? { systemPromptFile } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
		...(tokenInjection !== undefined ? { tokenInjection } : {}),
		...(settingSources !== undefined ? { settingSources } : {}),
		...(pinnedAccount !== undefined ? { pinnedAccount } : {}),
	};
}

export function resolveSystemPromptMode(settings: AnthropicSubscriptionProviderSettings): ResolvedSystemPromptMode {
	if (settings.systemPromptMode !== undefined) {
		return {
			mode: settings.systemPromptMode,
			source: systemPromptModeSources.get(settings) ?? "setting",
			conflict: settings.appendSystemPrompt !== undefined,
		};
	}
	if (settings.appendSystemPrompt !== undefined) {
		return {
			mode: settings.appendSystemPrompt ? "full" : "preset-append",
			source: "legacy",
			conflict: false,
		};
	}
	return { mode: "full", source: "default", conflict: false };
}

/** Load the provider block with env values taking precedence over project and global values. */
export function loadAnthropicSubscriptionProviderSettings(
	settingsManager: SettingsManager,
	environment: Environment = process.env,
): AnthropicSubscriptionProviderSettings {
	const global = settingsManager.getGlobalSettings() as SettingsWithAnthropicSubscriptionProvider;
	const project = settingsManager.getProjectSettings() as SettingsWithAnthropicSubscriptionProvider;
	const environmentSettings = parseEnvironmentSettings(environment);
	const settings = {
		...parseProviderSettings(global.anthropicSubscriptionProvider ?? global.claudeSdkOauthProvider),
		...parseProviderSettings(project.anthropicSubscriptionProvider ?? project.claudeSdkOauthProvider),
		...environmentSettings,
	};
	if (environmentSettings.systemPromptMode !== undefined) systemPromptModeSources.set(settings, "env");
	return settings;
}

function settingsFingerprint(path: string): string {
	return getFileContentRevision(path) ?? "missing";
}

let cachedAnthropicSubscriptionManager: { cwd: string; key: string; manager: SettingsManager } | undefined;

/** Load settings from Senpi's configured global and project settings.json paths. */
export function loadAnthropicSubscriptionProviderSettingsFromDisk(cwd: string): AnthropicSubscriptionProviderSettings {
	// fallbackEligible() calls this per candidate probe; cache the manager by
	// (cwd, settings content revision) and re-apply env live to avoid locked disk reads.
	const agentDir = getAgentDir();
	const key = `${cwd}|${settingsFingerprint(getSettingsPath(cwd, agentDir, "global"))}|${settingsFingerprint(
		getSettingsPath(cwd, agentDir, "project"),
	)}`;
	let settingsManager =
		cachedAnthropicSubscriptionManager?.cwd === cwd && cachedAnthropicSubscriptionManager.key === key
			? cachedAnthropicSubscriptionManager.manager
			: undefined;
	if (!settingsManager) {
		settingsManager = SettingsManager.create(cwd, agentDir);
		cachedAnthropicSubscriptionManager = { cwd, key, manager: settingsManager };
	}
	return loadAnthropicSubscriptionProviderSettings(settingsManager);
}
