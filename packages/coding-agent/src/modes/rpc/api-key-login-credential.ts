/**
 * The credential an RPC `login_api_key` stores. With a `region`, the provider's own interactive
 * API-key login runs with the region and key as its answers, so the stored credential is exactly
 * what the CLI's `/login` stores for the same choices (Kimi Code: the key plus its region env,
 * code-yeongyu/omo-desktop-app#4385). Without one it is the plain key, as before.
 */
import type { ApiKeyCredential, AuthPrompt, Provider } from "@earendil-works/pi-ai";

const REGION_LOGIN_TIMEOUT_MS = 15_000;

export async function apiKeyLoginCredential(
	provider: Provider | undefined,
	key: string,
	region: string | undefined,
): Promise<ApiKeyCredential> {
	if (region === undefined) return { type: "api_key", key };
	const login = provider?.auth.apiKey?.login;
	if (provider === undefined || login === undefined) {
		throw new Error(`${provider?.name ?? "This provider"} does not take a region for its API key.`);
	}
	let regionAsked = false;
	const answer = async (prompt: AuthPrompt): Promise<string> => {
		if (prompt.type === "secret") return key;
		if (prompt.type === "select") {
			if (!prompt.options.some((option) => option.id === region)) {
				throw new Error(`Unknown region "${region}" for ${provider.name}.`);
			}
			regionAsked = true;
			return region;
		}
		throw new Error(`${provider.name} asked for more than a key and a region.`);
	};
	const credential = await login({
		signal: AbortSignal.timeout(REGION_LOGIN_TIMEOUT_MS),
		prompt: answer,
		notify: () => {},
	});
	// The login may settle the region from the host's env and never ask: it still stored one. A login
	// that neither asked nor stored any env has no region to take.
	if (!regionAsked && credential.env === undefined) {
		throw new Error(`${provider.name} does not take a region for its API key.`);
	}
	return { ...credential, type: "api_key", key };
}
