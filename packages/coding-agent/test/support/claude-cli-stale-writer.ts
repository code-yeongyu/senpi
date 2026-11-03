import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type {
	AnthropicSubscriptionCredential,
	ClaudeCliAccountSlot,
} from "../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { createOAuthConfig } from "../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import { SCRIPTED_PROVIDER } from "../helpers/anthropic-subscription-scripted-sdk.ts";
import { fakeClaudeCliLogin } from "./fake-claude-cli-login.ts";

const LATER = 4_102_444_000_000;

/** The entry an engine from before senpi#4436 writes back: token-shaped login slots, no Claude CLI fields. */
export function staleEntry(...slots: Array<string | { name: string; displayName: string }>) {
	return {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		expires: 4102444800000,
		accounts: slots.map((slot) => {
			const { name, displayName } = typeof slot === "string" ? { name: slot, displayName: undefined } : slot;
			return {
				name,
				...(displayName === undefined ? {} : { displayName }),
				source: "login",
				access: `dummy-access-${name}`,
				refresh: `dummy-refresh-${name}`,
				expires: LATER,
			};
		}),
	};
}

export function storedAccounts(storage: AuthStorage): ClaudeCliAccountSlot[] {
	return ((storage.get(SCRIPTED_PROVIDER) as AnthropicSubscriptionCredential | undefined)?.accounts ??
		[]) as ClaudeCliAccountSlot[];
}

export function loginWith(storage: AuthStorage, cli: ReturnType<typeof fakeClaudeCliLogin>) {
	const config = createOAuthConfig({
		readCurrent: async () => storage.get(SCRIPTED_PROVIDER) as AnthropicSubscriptionCredential | undefined,
		claudeCli: { ...cli, store: () => storage },
	});
	return (name: string) =>
		config.login({ onPrompt: async (prompt) => (prompt.message.startsWith("Name for") ? name : "") });
}

export async function twoSignedInAccounts() {
	const cli = fakeClaudeCliLogin();
	const agentDir = cli.agentDir?.() as string;
	const authPath = join(agentDir, "auth.json");
	const storage = AuthStorage.create(authPath);
	const login = loginWith(storage, cli);
	await login("default");
	await login("second");
	const signedIn = storedAccounts(storage);
	expect(signedIn.map((slot) => slot.name)).toEqual(["default", "second"]);
	return { cli, agentDir, authPath, storage, signedIn };
}

export function writeStale(authPath: string, entry: unknown): void {
	const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
	writeFileSync(authPath, JSON.stringify({ ...data, [SCRIPTED_PROVIDER]: entry }, null, 2), { mode: 0o600 });
}

export function loaded(authPath: string): ClaudeCliAccountSlot[] {
	return storedAccounts(AuthStorage.create(authPath));
}
