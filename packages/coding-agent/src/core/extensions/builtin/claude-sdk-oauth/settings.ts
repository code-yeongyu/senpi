import { statSync } from "node:fs";
import { getAgentDir } from "../../../../config.ts";
import { getSettingsPath, type Settings, SettingsManager } from "../../../settings-manager.ts";
import type { SettingSource } from "./sdk-boundary.ts";

export type ClaudeSdkOauthSystemPromptMode = "preset-append" | "full" | "override";
export type ClaudeSdkOauthResumeMode = "auto" | "off";
export type ClaudeSdkOauthTokenInjection = "oauth-slots" | "config-dir" | "ambient";

export interface ClaudeSdkOauthProviderSettings {
	/**
	 * Explicit opt-in for the ambient (host Claude CLI) auth lane. Absent means
	 * false: a logged-in host CLI alone never makes this provider available,
	 * because that would silently spend the user's Claude subscription. Stored
	 * accounts and `CLAUDE_CODE_OAUTH_TOKEN*` are themselves explicit opt-ins
	 * and stay available without this flag.
	 */
	readonly enabled?: boolean;
	readonly appendSystemPrompt?: boolean;
	readonly systemPromptMode?: ClaudeSdkOauthSystemPromptMode;
	readonly systemPromptFile?: string;
	readonly resumeMode?: ClaudeSdkOauthResumeMode;
	readonly settingSources?: SettingSource[];
	readonly strictMcpConfig?: boolean;
	readonly pinnedAccount?: string;
	readonly tokenInjection?: ClaudeSdkOauthTokenInjection;
}

export type ResolvedSystemPromptMode = {
	mode: ClaudeSdkOauthSystemPromptMode;
	source: string;
	conflict: boolean;
};

type SettingsWithClaudeSdkOauthProvider = Settings & {
	claudeSdkOauthProvider?: unknown;
};

type Environment = Readonly<Record<string, string | undefined>>;

const systemPromptModeSources = new WeakMap<ClaudeSdkOauthProviderSettings, "env">();

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

function parseSystemPromptMode(value: unknown): ClaudeSdkOauthSystemPromptMode | undefined {
	return value === "preset-append" || value === "full" || value === "override" ? value : undefined;
}

function parseResumeMode(value: unknown): ClaudeSdkOauthResumeMode | undefined {
	return value === "auto" || value === "off" ? value : undefined;
}

function parseTokenInjection(value: unknown): ClaudeSdkOauthTokenInjection | undefined {
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

function parseProviderSettings(value: unknown): ClaudeSdkOauthProviderSettings {
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

function parseEnvironmentSettings(environment: Environment): ClaudeSdkOauthProviderSettings {
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

export function resolveSystemPromptMode(settings: ClaudeSdkOauthProviderSettings): ResolvedSystemPromptMode {
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
export function loadClaudeSdkOauthProviderSettings(
	settingsManager: SettingsManager,
	environment: Environment = process.env,
): ClaudeSdkOauthProviderSettings {
	const global = settingsManager.getGlobalSettings() as SettingsWithClaudeSdkOauthProvider;
	const project = settingsManager.getProjectSettings() as SettingsWithClaudeSdkOauthProvider;
	const environmentSettings = parseEnvironmentSettings(environment);
	const settings = {
		...parseProviderSettings(global.claudeSdkOauthProvider),
		...parseProviderSettings(project.claudeSdkOauthProvider),
		...environmentSettings,
	};
	if (environmentSettings.systemPromptMode !== undefined) systemPromptModeSources.set(settings, "env");
	return settings;
}

function settingsFingerprint(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

let cachedClaudeSdkOauthManager: { cwd: string; key: string; manager: SettingsManager } | undefined;

/** Load settings from Senpi's configured global and project settings.json paths. */
export function loadClaudeSdkOauthProviderSettingsFromDisk(cwd: string): ClaudeSdkOauthProviderSettings {
	// fallbackEligible() calls this per candidate probe; cache the manager by
	// (cwd, settings mtime+size) and re-apply env live to avoid locked disk reads.
	const agentDir = getAgentDir();
	const key = `${cwd}|${settingsFingerprint(getSettingsPath(cwd, agentDir, "global"))}|${settingsFingerprint(
		getSettingsPath(cwd, agentDir, "project"),
	)}`;
	let settingsManager =
		cachedClaudeSdkOauthManager?.cwd === cwd && cachedClaudeSdkOauthManager.key === key
			? cachedClaudeSdkOauthManager.manager
			: undefined;
	if (!settingsManager) {
		settingsManager = SettingsManager.create(cwd, agentDir);
		cachedClaudeSdkOauthManager = { cwd, key, manager: settingsManager };
	}
	return loadClaudeSdkOauthProviderSettings(settingsManager);
}
