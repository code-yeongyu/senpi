/**
 * senpi#5594: a fresh process that starts after a stale pre-#4436 writer reverted the Claude CLI slots must not tell
 * the user to sign in again for accounts its own load re-links. The re-link runs in the async load, so the startup
 * notices are taken only after it settles. All tokens are dummy strings; every dir is a temp dir.
 */
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { signInAgainMessage } from "../../../src/core/extensions/builtin/anthropic-subscription/sign-in-again.ts";
import { collectAuthDiagnostics, interactiveAuthNotices } from "../../../src/main.ts";
import { staleEntry, twoSignedInAccounts, writeStale } from "../../support/claude-cli-stale-writer.ts";
import { cleanupFakeClaudeCliLogins } from "../../support/fake-claude-cli-login.ts";

afterEach(() => {
	cleanupFakeClaudeCliLogins();
});

describe("senpi#5594 the startup notices follow the re-link", () => {
	it("an interactive start shows no sign-in-again notice for the accounts its load re-links", async () => {
		const { authPath } = await twoSignedInAccounts();
		writeStale(authPath, staleEntry("default"));

		const notices = await interactiveAuthNotices(AuthStorage.create(authPath));

		expect(notices.messages).toEqual([]);
	});

	it("a print or RPC start reports only the account no dir records, never the re-linked ones", async () => {
		const { authPath } = await twoSignedInAccounts();
		writeStale(authPath, staleEntry("default", "account-2"));

		const diagnostics = await collectAuthDiagnostics(AuthStorage.create(authPath), "runtime creation", {
			persistSeen: false,
		});

		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			`(runtime creation, auth storage) ${signInAgainMessage(["account-2"])}`,
		]);
	});
});
