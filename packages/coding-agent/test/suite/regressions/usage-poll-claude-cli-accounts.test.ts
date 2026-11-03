/**
 * After senpi#4436 every stored Claude account is a claude CLI account whose token lives in the CLI's own store
 * (`<agentDir>/anthropic-subscription-claude/<dirId>/.credentials.json`). The usage poll must still read those
 * accounts' limits, using the CLI's access token as it stands: read only, never refreshed. Tokens are dummy strings;
 * `fetch` is faked, so nothing leaves the process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountDirFor } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";
import { listPollAccounts } from "../../../src/core/subscription-limits/usage-accounts.ts";

const PROVIDER = "anthropic-subscription";
const NOW = 1_800_000_000_000;
const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentDirWith(
	accounts: Record<string, { readonly accessToken?: string; readonly expiresAt?: number }>,
): string {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-usage-poll-cli-"));
	roots.push(agentDir);
	for (const [dirId, oauth] of Object.entries(accounts)) {
		const dir = accountDirFor(agentDir, dirId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, ".credentials.json"),
			JSON.stringify({ claudeAiOauth: { refreshToken: "dummy-refresh", ...oauth } }),
		);
	}
	return agentDir;
}

function storeWith(accounts: readonly Record<string, unknown>[]): CredentialStore {
	const credential = {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		expires: 4102444800000,
		accounts,
	} as Credential;
	return {
		read: async (providerId) => (providerId === PROVIDER ? credential : undefined),
		list: async () => [],
		modify: async () => credential,
		delete: async () => {},
	};
}

const cliAccount = (name: string, dirId: string, extra: Record<string, unknown> = {}) => ({
	name,
	source: "login",
	store: "claude-cli",
	dirId,
	...extra,
});

async function tokensByAccount(agentDir: string | undefined, store: CredentialStore) {
	const accounts = await listPollAccounts({
		store,
		env: () => undefined,
		now: () => NOW,
		...(agentDir === undefined ? {} : { agentDir }),
	});
	const claude = accounts.filter((account) => account.provider === PROVIDER);
	return Object.fromEntries(
		await Promise.all(
			claude.map(async (account) => [account.account, await account.access(new AbortController().signal)] as const),
		),
	);
}

describe("the usage poll reads claude CLI accounts", () => {
	it("polls a claude CLI account with the CLI's own unexpired access token, under the account's name", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const dirId = "a".repeat(32);
		const agentDir = agentDirWith({ [dirId]: { accessToken: "dummy-cli-access", expiresAt: NOW + 3_600_000 } });

		const tokens = await tokensByAccount(agentDir, storeWith([cliAccount("my", dirId)]));

		expect(tokens).toEqual({ my: { access: "dummy-cli-access" } });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("offers no token for an expired, missing or malformed CLI credential, so nothing refreshes it", async () => {
		const expired = "b".repeat(32);
		const missing = "c".repeat(32);
		const malformed = "d".repeat(32);
		const agentDir = agentDirWith({
			[expired]: { accessToken: "dummy-expired", expiresAt: NOW - 1 },
			[malformed]: {},
		});

		const tokens = await tokensByAccount(
			agentDir,
			storeWith([
				cliAccount("expired", expired),
				cliAccount("missing", missing),
				cliAccount("malformed", malformed),
			]),
		);

		expect(tokens).toStrictEqual({ expired: undefined, missing: undefined, malformed: undefined });
	});

	it("skips a CLI account that still has to sign in again, one with an invalid dir id, and every CLI account when the agent dir is unknown", async () => {
		const valid = "e".repeat(32);
		const agentDir = agentDirWith({ [valid]: { accessToken: "dummy-valid", expiresAt: NOW + 3_600_000 } });
		const store = storeWith([
			cliAccount("retired", valid, { signInRequired: "legacy_sign_in_retired" }),
			cliAccount("escape", "../../outside"),
		]);

		expect(await tokensByAccount(agentDir, store)).toEqual({});
		expect(await tokensByAccount(undefined, storeWith([cliAccount("my", valid)]))).toEqual({});
	});
});
