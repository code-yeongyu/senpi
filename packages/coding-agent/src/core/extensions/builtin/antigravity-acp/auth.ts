import type {
	AuthCheck,
	AuthContext,
	AuthResult,
	OAuthCredential,
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { ANTIGRAVITY_ACP_NAME, SENTINEL_API_KEY } from "./constants.ts";
import {
	type AntigravityAcpSettings,
	type AntigravityAuthMethod,
	DEFAULT_ANTIGRAVITY_AUTH_METHOD,
} from "./settings.ts";

export type AntigravityOAuthConfig = {
	name: string;
	check(input: { ctx?: AuthContext; credential?: OAuthCredential }): Promise<AuthCheck | undefined>;
	resolveAmbient(input: { ctx?: AuthContext; signal?: AbortSignal }): Promise<AuthResult | undefined>;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
};

const AUTH_CHECK = { source: "Antigravity CLI (ACP)", type: "oauth" } as const;

function signInGuidance(authMethod: AntigravityAuthMethod | undefined): string {
	if (authMethod === "agent-platform") {
		return "GOOGLE_CLOUD_PROJECT (and Application Default Credentials) are required for agent-platform auth.";
	}
	return 'GEMINI_API_KEY is missing (or configure authMethod: "agent-platform" with GOOGLE_CLOUD_PROJECT). Set credentials, then run /login antigravity-acp again.';
}

export type AntigravityAuthDeps = {
	readonly readSettings: () => AntigravityAcpSettings;
	readonly readAuthStatus: (signal?: AbortSignal, options?: { force?: boolean }) => Promise<boolean>;
	readonly resolveExecutable: (settings: AntigravityAcpSettings) => string;
	readonly readStoredCredential: () => Promise<OAuthCredential | undefined>;
};

export function createAntigravityAuthConfig(deps: AntigravityAuthDeps): AntigravityOAuthConfig {
	const configuredFor = async (stored: OAuthCredential | undefined, signal?: AbortSignal): Promise<boolean> => {
		const settings = deps.readSettings();
		if (settings.enabled === false) return false;
		const optedIn = stored?.access === SENTINEL_API_KEY || settings.enabled === true;
		if (!optedIn) return false;
		return deps.readAuthStatus(signal);
	};

	return {
		name: ANTIGRAVITY_ACP_NAME,

		async check({ credential }) {
			const stored = credential ?? (await deps.readStoredCredential());
			return (await configuredFor(stored)) ? AUTH_CHECK : undefined;
		},

		async resolveAmbient({ signal }) {
			if (!(await configuredFor(await deps.readStoredCredential(), signal))) return undefined;
			return {
				auth: { apiKey: SENTINEL_API_KEY },
				source: AUTH_CHECK.source,
			};
		},

		async login(callbacks) {
			const settings = deps.readSettings();
			deps.resolveExecutable(settings);
			if (!(await deps.readAuthStatus(callbacks.signal, { force: true }))) {
				throw new Error(signInGuidance(settings.authMethod ?? DEFAULT_ANTIGRAVITY_AUTH_METHOD));
			}
			return sentinelCredential();
		},

		async refreshToken(credentials) {
			return credentials;
		},

		getApiKey() {
			return SENTINEL_API_KEY;
		},
	};
}

function sentinelCredential(): OAuthCredentials {
	return {
		access: SENTINEL_API_KEY,
		refresh: SENTINEL_API_KEY,
		expires: Number.MAX_SAFE_INTEGER,
	};
}
