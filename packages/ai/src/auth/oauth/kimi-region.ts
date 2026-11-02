import type { ProviderEnv } from "../../types.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { AuthPrompt, ProviderAuthInteraction } from "../types.ts";

/** Region ids match the official Kimi Code CLI's `kimi login --region` values. */
export type KimiCodeRegion = "mainland-cn" | "global";

export const KIMI_CODE_REGION_ENV = "KIMI_CODE_REGION";
export const KIMI_CODE_OAUTH_HOST_ENV = "KIMI_CODE_OAUTH_HOST";
export const KIMI_OAUTH_HOST_ENV = "KIMI_OAUTH_HOST";
export const DEFAULT_KIMI_CODE_REGION: KimiCodeRegion = "mainland-cn";

export interface KimiCodeRegionProfile {
	readonly id: KimiCodeRegion;
	readonly label: string;
	readonly description: string;
	readonly oauthHost: string;
	readonly apiBaseUrl: string;
}

export const KIMI_CODE_REGION_PROFILES: Readonly<Record<KimiCodeRegion, KimiCodeRegionProfile>> = {
	"mainland-cn": {
		id: "mainland-cn",
		label: "Mainland China (kimi.com)",
		description: "Accounts created on kimi.com",
		oauthHost: "https://auth.kimi.com",
		apiBaseUrl: "https://api.kimi.com/coding",
	},
	global: {
		id: "global",
		label: "Outside mainland China (kimi.ai)",
		description: "Accounts created on kimi.ai",
		oauthHost: "https://auth.kimi.ai",
		apiBaseUrl: "https://api.kimi.ai/coding",
	},
};

export interface KimiCodeEndpoints {
	readonly region: KimiCodeRegion | undefined;
	readonly oauthHost: string;
	/** Set only when the region moves inference off the provider's catalog base. */
	readonly apiBaseUrl: string | undefined;
	/** Credential metadata that makes refresh and inference follow this choice. */
	readonly env: ProviderEnv | undefined;
}

export interface KimiCodeEndpointInput {
	readonly storedRegion?: unknown;
	readonly storedOauthHost?: unknown;
	readonly envOauthHost?: string | undefined;
	readonly envRegion?: string | undefined;
}

export function isKimiCodeRegion(value: unknown): value is KimiCodeRegion {
	return value === "mainland-cn" || value === "global";
}

function normalizeHost(host: string): string {
	return host.trim().replace(/\/+$/, "");
}

export function kimiCodeRegionForOauthHost(host: string): KimiCodeRegion | undefined {
	const normalized = normalizeHost(host);
	for (const profile of Object.values(KIMI_CODE_REGION_PROFILES)) {
		if (profile.oauthHost === normalized) return profile.id;
	}
	return undefined;
}

function endpointsForRegion(region: KimiCodeRegion): KimiCodeEndpoints {
	const profile = KIMI_CODE_REGION_PROFILES[region];
	return {
		region,
		oauthHost: profile.oauthHost,
		apiBaseUrl: region === DEFAULT_KIMI_CODE_REGION ? undefined : profile.apiBaseUrl,
		env: { [KIMI_CODE_REGION_ENV]: region },
	};
}

function endpointsForHost(host: string): KimiCodeEndpoints {
	const region = kimiCodeRegionForOauthHost(host);
	if (region !== undefined) return endpointsForRegion(region);
	return {
		region: undefined,
		oauthHost: normalizeHost(host),
		apiBaseUrl: undefined,
		env: { [KIMI_CODE_OAUTH_HOST_ENV]: normalizeHost(host) },
	};
}

/**
 * A credential's stored host or region owns its refresh and inference routing;
 * the process env only decides for credentials that predate regions and for
 * new logins.
 */
export function resolveKimiCodeEndpoints(input: KimiCodeEndpointInput): KimiCodeEndpoints {
	if (typeof input.storedOauthHost === "string" && input.storedOauthHost.trim()) {
		return endpointsForHost(input.storedOauthHost);
	}
	if (isKimiCodeRegion(input.storedRegion)) return endpointsForRegion(input.storedRegion);
	if (input.envOauthHost?.trim()) return endpointsForHost(input.envOauthHost);
	if (isKimiCodeRegion(input.envRegion)) return endpointsForRegion(input.envRegion);
	return { ...endpointsForRegion(DEFAULT_KIMI_CODE_REGION), env: undefined };
}

export function kimiCodeCredentialEnv(credential: Readonly<Record<string, unknown>>): ProviderEnv | undefined {
	const value = credential.env;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const env: ProviderEnv = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry === "string") env[name] = entry;
	}
	return env;
}

export function kimiCodeEndpointsForCredential(credential: Readonly<Record<string, unknown>>): KimiCodeEndpoints {
	const env = kimiCodeCredentialEnv(credential);
	return resolveKimiCodeEndpoints({
		storedRegion: env?.[KIMI_CODE_REGION_ENV],
		storedOauthHost: env?.[KIMI_CODE_OAUTH_HOST_ENV],
		envOauthHost: getProviderEnvValue(KIMI_CODE_OAUTH_HOST_ENV) || getProviderEnvValue(KIMI_OAUTH_HOST_ENV),
		envRegion: getProviderEnvValue(KIMI_CODE_REGION_ENV),
	});
}

export function kimiCodeRegionPrompt(): AuthPrompt {
	return {
		type: "select",
		message: "Which Kimi service hosts your account?",
		options: Object.values(KIMI_CODE_REGION_PROFILES).map((profile) => ({
			id: profile.id,
			label: profile.label,
			description: profile.description,
		})),
	};
}

/** An explicit host or region in the env skips the prompt so headless logins keep working. */
export async function chooseKimiCodeLoginEndpoints(interaction: ProviderAuthInteraction): Promise<KimiCodeEndpoints> {
	const fromEnv = resolveKimiCodeEndpoints({
		envOauthHost: getProviderEnvValue(KIMI_CODE_OAUTH_HOST_ENV) || getProviderEnvValue(KIMI_OAUTH_HOST_ENV),
		envRegion: getProviderEnvValue(KIMI_CODE_REGION_ENV),
	});
	if (fromEnv.env !== undefined) return fromEnv;
	interaction.signal.throwIfAborted();
	const answer = await interaction.prompt(kimiCodeRegionPrompt());
	interaction.signal.throwIfAborted();
	if (!isKimiCodeRegion(answer)) {
		throw new Error(`Unknown Kimi Code region: ${answer}`);
	}
	return endpointsForRegion(answer);
}
