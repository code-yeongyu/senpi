import type { Api, Model } from "@earendil-works/pi-ai";

/** The model fields the native image-generation gate and its cache key depend on. */
export type NativeImageGenModel = Pick<Model<Api>, "id" | "provider" | "api" | "baseUrl" | "compat">;
export type NativeImageGenTarget = NativeImageGenModel | undefined;

const ENABLE_ENV = "PI_OPENAI_IMAGE_GEN";
const OFFICIAL_OPENAI_HOST = "api.openai.com";
const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";

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

function isOfficialOpenAiEndpoint(baseUrl: string): boolean {
	try {
		return new URL(baseUrl || OFFICIAL_OPENAI_BASE_URL).hostname === OFFICIAL_OPENAI_HOST;
	} catch {
		return false;
	}
}

/**
 * Whether the model's endpoint serves the OpenAI Responses `image_generation`
 * server tool.
 *
 * Unlike the web-search gate, `azure-openai-responses` defaults to FALSE: Azure
 * deployments expose image generation as a separate deployment rather than as a
 * Responses server tool, so azure opts in only through
 * `compat.supportsImageGeneration`. Proxied `openai-responses` endpoints default
 * to the client tool for the same reason they do for web search: a translating
 * gateway rejects the tool type it never implemented.
 */
export function supportsNativeOpenAiImageGeneration(target: NativeImageGenTarget): boolean {
	if (target === undefined || target.api !== "openai-responses") {
		return false;
	}

	const override = compatImageGenerationOverride(target.compat);
	return override ?? isOfficialOpenAiEndpoint(target.baseUrl);
}

/** Identity of the model an arbitration decision was made for. */
export function nativeImageGenModelKey(target: NativeImageGenTarget): string {
	if (target === undefined) return "";
	return `${target.provider}|${target.api}|${target.baseUrl}|${target.id}`;
}
