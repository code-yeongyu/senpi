import type { Api, Model } from "@earendil-works/pi-ai";

/** The model fields the native image-generation gate and its cache key depend on. */
export type NativeImageGenModel = Pick<Model<Api>, "id" | "provider" | "api" | "baseUrl" | "compat">;
export type NativeImageGenTarget = NativeImageGenModel | undefined;

const ENABLE_ENV = "PI_OPENAI_IMAGE_GEN";
const OFFICIAL_OPENAI_HOST = "api.openai.com";
const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OFFICIAL_CODEX_HOST = "chatgpt.com";

function parseEnableEnv(envVar: string): boolean {
	const envValue = process.env[envVar];
	if (!envValue) {
		return true;
	}

	const normalized = envValue.trim().toLowerCase();
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
		return false;
	}

	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
		return true;
	}

	// Unknown values fall back to default-on behavior.
	return true;
}

/** Whether native image generation injection is enabled for this process. */
export function isOpenAiImageGenEnabled(): boolean {
	return parseEnableEnv(ENABLE_ENV);
}

/** Reads `compat.supportsImageGeneration` without narrowing the per-api compat union by cast. */
function compatImageGenerationOverride(compat: unknown): boolean | undefined {
	if (typeof compat !== "object" || compat === null || !("supportsImageGeneration" in compat)) {
		return undefined;
	}
	const value = compat.supportsImageGeneration;
	return typeof value === "boolean" ? value : undefined;
}

function isOfficialOpenAiEndpoint(target: NativeImageGenModel): boolean {
	try {
		if (target.api === "openai-codex-responses") {
			return new URL(target.baseUrl).hostname === OFFICIAL_CODEX_HOST;
		}
		return new URL(target.baseUrl || OFFICIAL_OPENAI_BASE_URL).hostname === OFFICIAL_OPENAI_HOST;
	} catch {
		return false;
	}
}

/**
 * Whether the model's endpoint serves the OpenAI Responses `image_generation`
 * server tool.
 *
 * Official Responses and Codex OAuth endpoints default to TRUE without changing
 * the model's transport. Unlike the web-search gate, Azure is excluded: Azure
 * deployments expose image generation as a separate deployment rather than as a
 * Responses server tool. Proxied Responses and Codex endpoints default
 * to the client tool for the same reason they do for web search: a translating
 * gateway rejects the tool type it never implemented. They can opt in through
 * `compat.supportsImageGeneration`.
 */
export function supportsNativeOpenAiImageGeneration(target: NativeImageGenTarget): boolean {
	if (target === undefined || (target.api !== "openai-responses" && target.api !== "openai-codex-responses")) {
		return false;
	}

	const override = compatImageGenerationOverride(target.compat);
	return override ?? isOfficialOpenAiEndpoint(target);
}

/** Identity of the model an arbitration decision was made for. */
export function nativeImageGenModelKey(target: NativeImageGenTarget): string {
	if (target === undefined) return "";
	return `${target.provider}|${target.api}|${target.baseUrl}|${target.id}`;
}
