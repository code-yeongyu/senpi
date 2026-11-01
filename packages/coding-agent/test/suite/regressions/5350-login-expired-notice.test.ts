/**
 * senpi#5350 (PR-A): the startup notice for accounts that must sign in again follows each account's reason. An
 * expired Claude CLI login says "expired"; the retired sign-in (senpi#4436) keeps its text byte for byte.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	type AccountSlot,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

const PROVIDER = "anthropic-subscription";
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function startupNotices(...slots: AccountSlot[]): string[] {
	const dir = mkdtempSync(join(tmpdir(), "senpi-5350-notice-"));
	dirs.push(dir);
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify({ [PROVIDER]: slots.reduce(addAccount, emptyCredential()) }), { mode: 0o600 });
	return AuthStorage.create(path)
		.takePendingNotices({ persistSeen: false })
		.map((notice) => notice.message);
}

const expired = (name: string) => cliSlot(name, { signInRequired: "login_expired", blockReason: "auth_error" });
const retired = (name: string) => cliSlot(name, { signInRequired: "legacy_sign_in_retired" });

describe("senpi#5350 the startup sign-in notice names an expired Claude sign-in", () => {
	it("an expired CLI login gets the expired text", () => {
		expect(startupNotices(expired("alice"), cliSlot("bravo"))).toEqual([
			"Claude sign-in expired. Sign in again with Claude to keep using: alice. Run /login anthropic-subscription.",
		]);
	});

	it("guard: the retired sign-in notice text is unchanged", () => {
		expect(startupNotices(retired("old"), cliSlot("bravo"))).toEqual([
			"Claude sign-in changed. Sign in again with Claude to keep using: old. Run /login anthropic-subscription.",
		]);
	});

	it("a pool with both reasons gets one sentence per reason, the retired sign-in first", () => {
		expect(startupNotices(expired("alice"), retired("old"))).toEqual([
			"Claude sign-in changed. Sign in again with Claude to keep using: old. Run /login anthropic-subscription. " +
				"Claude sign-in expired. Sign in again with Claude to keep using: alice. Run /login anthropic-subscription.",
		]);
	});
});
