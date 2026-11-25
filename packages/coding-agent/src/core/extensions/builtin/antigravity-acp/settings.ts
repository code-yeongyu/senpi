import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_KEY } from "./constants.ts";

export type AntigravityResumeMode = "auto" | "off";
export type AntigravityAuthMethod = "gemini-api-key" | "agent-platform";
export const DEFAULT_ANTIGRAVITY_AUTH_METHOD: AntigravityAuthMethod = "gemini-api-key";

export interface AntigravityAcpSettings {
	readonly enabled?: boolean;
	readonly executablePath?: string;
	readonly resumeMode?: AntigravityResumeMode;
	readonly authMethod?: AntigravityAuthMethod;
}

type Environment = Readonly<Record<string, string | undefined>>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResumeMode(value: unknown): AntigravityResumeMode | undefined {
	return value === "auto" || value === "off" ? value : undefined;
}

function parseAuthMethod(value: unknown): AntigravityAuthMethod | undefined {
	return value === "gemini-api-key" || value === "agent-platform" ? value : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
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

export function parseAntigravityAcpSettings(value: unknown): AntigravityAcpSettings {
	if (!isRecord(value)) return {};
	const enabled = parseBoolean(value.enabled);
	const executablePath = parseNonEmptyString(value.executablePath);
	const resumeMode = parseResumeMode(value.resumeMode);
	const authMethod = parseAuthMethod(value.authMethod);
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(executablePath !== undefined ? { executablePath } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
		...(authMethod !== undefined ? { authMethod } : {}),
	};
}

function parseEnvironmentSettings(environment: Environment): AntigravityAcpSettings {
	const enabled = parseEnvironmentBoolean(environment.SENPI_ANTIGRAVITY_ACP_ENABLED);
	const executablePath = parseNonEmptyString(environment.SENPI_ANTIGRAVITY_ACP_EXECUTABLE);
	const resumeMode = parseResumeMode(environment.SENPI_ANTIGRAVITY_ACP_RESUME);
	const authMethod = parseAuthMethod(environment.SENPI_ANTIGRAVITY_ACP_AUTH_METHOD);
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(executablePath !== undefined ? { executablePath } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
		...(authMethod !== undefined ? { authMethod } : {}),
	};
}

function readSettingsFile(filePath: string): AntigravityAcpSettings {
	if (!existsSync(filePath)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isRecord(parsed)) return {};
		return parseAntigravityAcpSettings(parsed[SETTINGS_KEY]);
	} catch {
		return {};
	}
}

/**
 * Load provider settings strictly from the user's global agent directory and environment.
 * Untrusted project directories must not enable the provider or override `executablePath`
 * (see senpi#6362).
 */
export function loadAntigravityAcpSettingsFromDisk(
	_cwd: string,
	agentDir: string,
	environment: Environment = process.env,
): AntigravityAcpSettings {
	const globalSettings = readSettingsFile(join(agentDir, "settings.json"));
	return {
		...globalSettings,
		...parseEnvironmentSettings(environment),
	};
}
