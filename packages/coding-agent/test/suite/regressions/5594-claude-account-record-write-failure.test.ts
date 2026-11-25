/**
 * senpi#5594 review: the account dir record only lets a later stale write be undone, so a sign-in whose record cannot
 * be written stands and the failure is reported; the next load's backfill writes the record again. The fake CLI
 * occupies the record's path with a directory; every dir is a temp dir.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { AnthropicSubscriptionCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { accountDirFor } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import { SCRIPTED_PROVIDER } from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { storedAccounts } from "../../support/claude-cli-stale-writer.ts";
import { cleanupFakeClaudeCliLogins, fakeClaudeCliLogin } from "../../support/fake-claude-cli-login.ts";

afterEach(() => {
	cleanupFakeClaudeCliLogins();
});

describe("senpi#5594 a failed account dir record write never undoes a sign-in", () => {
	it("keeps the signed-in account and reports the record failure once", async () => {
		const base = fakeClaudeCliLogin();
		const agentDir = base.agentDir?.() as string;
		const storage = AuthStorage.create(join(agentDir, "auth.json"));
		const config = createOAuthConfig({
			readCurrent: async () => storage.get(SCRIPTED_PROVIDER) as AnthropicSubscriptionCredential | undefined,
			claudeCli: {
				...base,
				env: () => ({ ...base.env?.(), FAKE_CLAUDE_BLOCK_ACCOUNT_RECORD: "1" }),
				store: () => storage,
			},
		});
		const progress: string[] = [];

		await config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith("Name for") ? "default" : ""),
			onProgress: (message) => progress.push(message),
		});

		const [slot] = storedAccounts(storage);
		expect(slot).toMatchObject({ name: "default", store: "claude-cli" });
		expect(slot?.signInRequired).toBeUndefined();
		expect(existsSync(accountDirFor(agentDir, slot?.dirId as string))).toBe(true);
		expect(progress.filter((message) => message.includes("account dir record could not be written"))).toHaveLength(1);
	});
});
