/**
 * senpi#5594: two Claude accounts signed in through the CLI survive an engine from before senpi#4436 that is still
 * running and writes its stale token-shaped copy of the entry back over the Claude CLI slots. The next load re-links
 * every signed-in account dir the stale write left unreferenced, instead of minting a fresh dir and asking the
 * account to sign in again. All tokens are dummy strings; every dir is a temp dir.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountDirFor } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";
import { loaded, staleEntry, twoSignedInAccounts, writeStale } from "../../support/claude-cli-stale-writer.ts";
import { cleanupFakeClaudeCliLogins } from "../../support/fake-claude-cli-login.ts";

afterEach(() => {
	cleanupFakeClaudeCliLogins();
});

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
		writeStale(authPath, { ...staleEntry(), accounts: signedIn.slice(0, 1) });

		expect(loaded(authPath).map((slot) => slot.name)).toEqual(["default"]);
	});
});
