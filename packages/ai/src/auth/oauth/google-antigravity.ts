import { googleOAuthExports, refreshGoogleToken } from "./google-oauth-shared.ts";

const decode = (value: string) => atob(value);
const ENDPOINT = "https://cloudcode-pa.googleapis.com";
const metadata = { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } as const;
const config = {
	id: "google-antigravity",
	name: "Google Antigravity",
	port: 51121,
	path: "/oauth-callback",
	clientId: decode(
		"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
	),
	clientSecret: decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY="),
	scopes: [
		"https://www.googleapis.com/auth/cloud-platform",
		"https://www.googleapis.com/auth/userinfo.email",
		"https://www.googleapis.com/auth/userinfo.profile",
		"https://www.googleapis.com/auth/cclog",
		"https://www.googleapis.com/auth/experimentsandconfigs",
	],
	discoverProject: discoverAntigravityProject,
};

function projectId(value: unknown): string | undefined {
	if (typeof value === "string" && value) return value;
	if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && value.id) return value.id;
	return undefined;
}

export async function discoverAntigravityProject(accessToken: string, signal?: AbortSignal): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "antigravity-ide",
	};
	const load = await fetch(`${ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({ metadata }),
		signal,
	});
	if (!load.ok) throw new Error(`Google Antigravity project discovery failed (${load.status})`);
	const payload = (await load.json()) as {
		cloudaicompanionProject?: unknown;
		allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
	};
	const existing = projectId(payload.cloudaicompanionProject);
	if (existing) return existing;
	const tierId = payload.allowedTiers?.find((tier) => tier.isDefault)?.id ?? "legacy-tier";
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const onboard = await fetch(`${ENDPOINT}/v1internal:onboardUser`, {
			method: "POST",
			headers,
			body: JSON.stringify({ tierId, metadata }),
			signal,
		});
		if (!onboard.ok) throw new Error(`Google Antigravity onboarding failed (${onboard.status})`);
		const operation = (await onboard.json()) as { done?: boolean; response?: { cloudaicompanionProject?: unknown } };
		const project = operation.done ? projectId(operation.response?.cloudaicompanionProject) : undefined;
		if (project) return project;
		if (attempt < 4) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 2000);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		}
	}
	throw new Error("Google Antigravity onboarding returned no projectId");
}

const exports = googleOAuthExports(config);
export const googleAntigravityOAuth = exports.auth;
export const googleAntigravityOAuthProvider = exports.provider;
export const loginAntigravity = googleAntigravityOAuthProvider.login;
export const refreshAntigravityToken = (refresh: string, projectIdValue: string, signal?: AbortSignal) =>
	refreshGoogleToken(config, refresh, projectIdValue, signal);
