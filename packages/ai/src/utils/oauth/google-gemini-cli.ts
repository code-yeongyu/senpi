import { googleOAuthExports, refreshGoogleToken } from "./google-oauth-shared.ts";

const decode = (value: string) => atob(value);
const ENDPOINT = "https://cloudcode-pa.googleapis.com";
const metadata = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } as const;
const config = {
	id: "google-gemini-cli",
	name: "Google Gemini CLI",
	port: 8085,
	path: "/oauth2callback",
	clientId: decode("NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t"),
	clientSecret: decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw="),
	scopes: [
		"https://www.googleapis.com/auth/cloud-platform",
		"https://www.googleapis.com/auth/userinfo.email",
		"https://www.googleapis.com/auth/userinfo.profile",
	],
	discoverProject: discoverGeminiCliProject,
};

function projectId(value: unknown): string | undefined {
	if (typeof value === "string" && value) return value;
	if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && value.id) return value.id;
	return undefined;
}

export async function discoverGeminiCliProject(accessToken: string, signal?: AbortSignal): Promise<string> {
	const configuredProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
	const load = await fetch(`${ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			cloudaicompanionProject: configuredProject,
			metadata: { ...metadata, duetProject: configuredProject },
		}),
		signal,
	});
	if (!load.ok) throw new Error(`Google Gemini CLI project discovery failed (${load.status})`);
	const payload = (await load.json()) as {
		cloudaicompanionProject?: string | { id?: string };
		currentTier?: { id?: string };
		allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
	};
	const existing = projectId(payload.cloudaicompanionProject);
	if (existing) return existing;
	if (payload.currentTier) {
		if (configuredProject) return configuredProject;
		throw new Error("Google Gemini CLI account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID");
	}
	const tierId = payload.allowedTiers?.find((tier) => tier.isDefault)?.id ?? "legacy-tier";
	if (tierId !== "free-tier" && !configuredProject) {
		throw new Error("Google Gemini CLI account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID");
	}
	const onboard = await fetch(`${ENDPOINT}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			tierId,
			...(configuredProject && { cloudaicompanionProject: configuredProject }),
			metadata: { ...metadata, ...(configuredProject && { duetProject: configuredProject }) },
		}),
		signal,
	});
	if (!onboard.ok) throw new Error(`Google Gemini CLI onboarding failed (${onboard.status})`);
	let operation = (await onboard.json()) as {
		name?: string;
		done?: boolean;
		response?: { cloudaicompanionProject?: unknown };
	};
	for (let attempt = 0; !operation.done && operation.name && attempt < 12; attempt += 1) {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, 1000);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(signal.reason);
				},
				{ once: true },
			);
		});
		const poll = await fetch(`${ENDPOINT}/v1internal/${operation.name}`, { headers, signal });
		if (!poll.ok) throw new Error(`Google Gemini CLI onboarding poll failed (${poll.status})`);
		operation = (await poll.json()) as typeof operation;
	}
	return (
		projectId(operation.response?.cloudaicompanionProject) ??
		configuredProject ??
		(() => {
			throw new Error("Google Gemini CLI onboarding returned no projectId");
		})()
	);
}

const exports = googleOAuthExports(config);
export const googleGeminiCliOAuth = exports.auth;
export const googleGeminiCliOAuthProvider = exports.provider;
export const loginGeminiCli = googleGeminiCliOAuthProvider.login;
export const refreshGoogleCloudToken = (refresh: string, projectIdValue: string, signal?: AbortSignal) =>
	refreshGoogleToken(config, refresh, projectIdValue, signal);
