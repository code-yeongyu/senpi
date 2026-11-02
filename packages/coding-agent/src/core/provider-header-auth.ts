import { type AuthCheck, type AuthContext, hasCredentialHeaders, isCredentialHeaderName } from "@earendil-works/pi-ai";
import { type ConfigValue, isConfigReference } from "@earendil-works/pi-ai/utils/config-reference";
import { assertConfigReferenceAuthority } from "./config-reference-resolver.ts";
import { getConfigValueEnvVarNames, isCommandConfigValue, isConfigValueConfigured } from "./resolve-config-value.ts";

export type HeaderAuthStatusSource = "extension_headers" | "models_json_headers";

interface EffectiveHeader {
	name: string;
	value: ConfigValue;
	source: HeaderAuthStatusSource;
}

export function configuredHeaderAuthStatus(
	configHeaders: Record<string, ConfigValue> | undefined,
	extensionHeaders: Record<string, string> | undefined,
):
	| { configured: true; source: HeaderAuthStatusSource | "environment" | "models_json_command"; label?: string }
	| { configured: false }
	| undefined {
	let sawCredentialHeader = false;
	for (const header of effectiveHeaders(configHeaders, extensionHeaders).values()) {
		if (!isCredentialHeaderName(header.name)) continue;
		sawCredentialHeader = true;
		if (isCommandConfigValue(header.value)) return { configured: true, source: "models_json_command" };
		const envNames = getConfigValueEnvVarNames(header.value);
		if (envNames.length > 0) {
			if (isConfigValueConfigured(header.value)) {
				return { configured: true, source: "environment", label: envNames.join(", ") };
			}
			continue;
		}
		if (isConfiguredCredentialHeader(header)) {
			return { configured: true, source: header.source };
		}
	}
	return sawCredentialHeader ? { configured: false } : undefined;
}

export function headerAuthResolutionSource(
	configHeaders: Record<string, ConfigValue> | undefined,
	extensionHeaders: Record<string, string> | undefined,
): string | undefined {
	const headers = effectiveHeaders(configHeaders, extensionHeaders);
	for (const header of headers.values()) {
		if (!isConfiguredCredentialHeader(header)) continue;
		return header.source === "extension_headers" ? "provider extension headers" : "models.json headers";
	}
	return undefined;
}

export async function checkConfiguredHeaderAuth(
	headers: Record<string, ConfigValue> | undefined,
	ctx: AuthContext,
	source: string | undefined,
): Promise<AuthCheck | undefined> {
	if (!headers) return undefined;
	for (const header of effectiveHeaders(headers, undefined).values()) {
		if (!isCredentialHeaderName(header.name)) continue;
		if (typeof header.value !== "string") return { type: "api_key", source };
		if (isCommandConfigValue(header.value)) return { type: "api_key", source };
		const envNames = getConfigValueEnvVarNames(header.value);
		let configured = true;
		for (const envName of envNames) {
			if ((await ctx.env(envName)) !== undefined) continue;
			configured = false;
			break;
		}
		if (configured && isConfiguredCredentialHeader(header)) {
			return { type: "api_key", source };
		}
	}
	return undefined;
}

function effectiveHeaders(
	configHeaders: Record<string, ConfigValue> | undefined,
	extensionHeaders: Record<string, string> | undefined,
): Map<string, EffectiveHeader> {
	const effective = new Map<string, EffectiveHeader>();
	addHeaders(effective, configHeaders, "models_json_headers");
	addHeaders(effective, extensionHeaders, "extension_headers");
	return effective;
}

function addHeaders(
	target: Map<string, EffectiveHeader>,
	headers: Record<string, ConfigValue> | undefined,
	source: HeaderAuthStatusSource,
): void {
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (source === "extension_headers") {
			assertConfigReferenceAuthority(value, {
				origin: "provider extension",
				field: `extension.headers.${name}`,
				authority: "extension",
			});
		}
		if (typeof value !== "string" && !isConfigReference(value)) continue;
		assertConfigReferenceAuthority(value);
		target.set(name.toLowerCase(), { name, value, source });
	}
}

function isConfiguredCredentialHeader(header: EffectiveHeader): boolean {
	return (
		isCredentialHeaderName(header.name) &&
		(typeof header.value !== "string" || hasCredentialHeaders({ [header.name]: header.value }))
	);
}
