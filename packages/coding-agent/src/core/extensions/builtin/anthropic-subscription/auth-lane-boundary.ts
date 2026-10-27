import type { CredentialStore } from "@earendil-works/pi-ai";
import { loadAnthropicOAuth } from "@earendil-works/pi-ai/oauth";
import { getAgentDir } from "../../../../config.ts";
import { AuthStorage } from "../../../auth-storage.ts";
import type { SlotRefresher } from "./accounts.ts";

type AuthLaneBoundary = {
	createStore: () => CredentialStore;
	env: () => NodeJS.ProcessEnv;
	getAgentDir: () => string;
	now: () => number;
	refresher: SlotRefresher;
};

async function refreshWithAnthropicOAuth(refresh: string, signal: AbortSignal) {
	const oauth = await loadAnthropicOAuth();
	const credential = await oauth.refresh({ type: "oauth", access: "", refresh, expires: 0 }, signal);
	return { access: credential.access, refresh: credential.refresh, expires: credential.expires };
}

const defaultBoundary: AuthLaneBoundary = {
	createStore: () => AuthStorage.create(),
	env: () => process.env,
	getAgentDir,
	now: () => Date.now(),
	refresher: refreshWithAnthropicOAuth,
};
export let activeBoundary = defaultBoundary;

export function overrideAuthLaneBoundary(override: Partial<AuthLaneBoundary>): void {
	activeBoundary = { ...activeBoundary, ...override };
}

export function resetAuthLaneBoundary(): void {
	activeBoundary = defaultBoundary;
}

/** The refresher turns use, so the usage poller renews an expiring account the same way (senpi#3684). */
export function authLaneRefresher(): SlotRefresher {
	return activeBoundary.refresher;
}
