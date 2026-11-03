/**
 * senpi#5594: two Claude accounts signed in through the CLI survive an engine from before senpi#4436 that is still
 * running and writes its stale token-shaped copy of the entry back over the Claude CLI slots. The next load re-links
 * every signed-in account dir the stale write left unreferenced, instead of minting a fresh dir and asking the
 * account to sign in again. All tokens are dummy strings; every dir is a temp dir.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type {
	AnthropicSubscriptionCredential,
	ClaudeCliAccountSlot,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { accountDirFor } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import { SCRIPTED_PROVIDER } from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { cleanupFakeClaudeCliLogins, fakeClaudeCliLogin } from "../../support/fake-claude-cli-login.ts";

const roots: string[] = [];
const LATER = 4_102_444_000_000;

afterEach(() => {
	cleanupFakeClaudeCliLogins();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function grant(name: string) {
	return { name, source: "login", access: `dummy-access-${name}`, refresh: `dummy-refresh-${name}`, expires: LATER };
}

function staleEntry(...names: string[]) {
	return {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		expires: 4102444800000,
		accounts: names.map(grant),
	};
}

async function twoSignedInAccounts() {
	const cli = fakeClaudeCliLogin();
	const agentDir = cli.agentDir?.() as string;
	const authPath = join(agentDir, "auth.json");
	const storage = AuthStorage.create(authPath);
	const config = createOAuthConfig({
		readCurrent: async () => storage.get(SCRIPTED_PROVIDER) as AnthropicSubscriptionCredential | undefined,
		claudeCli: { ...cli, store: () => storage },
	});
	for (const answer of ["default", "second"]) {
		await config.login({ onPrompt: async (prompt) => (prompt.message.startsWith("Name for") ? answer : "") });
	}
	const signedIn = (storage.get(SCRIPTED_PROVIDER) as AnthropicSubscriptionCredential)
		.accounts as ClaudeCliAccountSlot[];
	expect(signedIn.map((slot) => slot.name)).toEqual(["default", "second"]);
	return { agentDir, authPath, signedIn };
}

function writeStale(authPath: string, entry: unknown): void {
	const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
	writeFileSync(authPath, JSON.stringify({ ...data, [SCRIPTED_PROVIDER]: entry }, null, 2), { mode: 0o600 });
}

function loaded(authPath: string): ClaudeCliAccountSlot[] {
	return (AuthStorage.create(authPath).get(SCRIPTED_PROVIDER) as AnthropicSubscriptionCredential)
		.accounts as ClaudeCliAccountSlot[];
}

describe("senpi#5594 a stale pre-#4436 writer does not lose signed-in Claude accounts", () => {
	it("re-links both account dirs after the stale writer kept only one token-shaped account", async () => {
		const { agentDir, authPath, signedIn } = await twoSignedInAccounts();
		writeStale(authPath, staleEntry("default"));

		const accounts = loaded(authPath);

		expect(accounts.map((slot) => [slot.name, slot.dirId, slot.signInRequired])).toEqual(
			signedIn.map((slot) => [slot.name, slot.dirId, undefined]),
		);
		expect(accounts.every((slot) => slot.store === "claude-cli" && slot.access === undefined)).toBe(true);
		for (const slot of signedIn) expect(existsSync(accountDirFor(agentDir, slot.dirId))).toBe(true);
		expect(readFileSync(authPath, "utf8")).not.toContain("dummy-access");
	});

	it("keeps the account a stale writer appended, signed out, beside the re-linked ones", async () => {
		const { authPath, signedIn } = await twoSignedInAccounts();
		writeStale(authPath, staleEntry("default", "account-2"));

		const accounts = loaded(authPath);

		expect(accounts.map((slot) => slot.name)).toEqual(["default", "account-2", "second"]);
		expect(accounts[0]?.dirId).toBe(signedIn[0]?.dirId);
		expect(accounts[1]).toMatchObject({ store: "claude-cli", signInRequired: "legacy_sign_in_retired" });
		expect(accounts[2]?.dirId).toBe(signedIn[1]?.dirId);
	});

	it("re-links the newest sign-in when two dirs record the same account, and a second load writes nothing", async () => {
		const { agentDir, authPath, signedIn } = await twoSignedInAccounts();
		const older = "a".repeat(32);
		mkdirSync(accountDirFor(agentDir, older), { recursive: true });
		writeFileSync(join(accountDirFor(agentDir, older), ".senpi-account.json"), '{"name":"default","signedInAt":0}');
		writeStale(authPath, staleEntry("default"));

		const accounts = loaded(authPath);
		const bytes = readFileSync(authPath, "utf8");

		expect(accounts.find((slot) => slot.name === "default")?.dirId).toBe(signedIn[0]?.dirId);
		expect(loaded(authPath)).toEqual(accounts);
		expect(readFileSync(authPath, "utf8")).toBe(bytes);
	});

	it("does not resurrect a removed account when no stale writer ran", async () => {
		const { authPath, signedIn } = await twoSignedInAccounts();
		const kept = signedIn.slice(0, 1);
		writeStale(authPath, { ...staleEntry(), accounts: kept });

		expect(loaded(authPath).map((slot) => slot.name)).toEqual(["default"]);
	});
});
