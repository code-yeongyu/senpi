/**
 * senpi#5594: the account dir record follows a rename, and concurrent writers on one auth.json plus a re-login keep
 * both Claude accounts. Two AuthStorage instances on the same file stand in for two processes; every write goes
 * through the auth.json file lock. All tokens are dummy strings; every dir is a temp dir.
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { renameCredentialAccount } from "../../../src/core/credential-accounts.ts";
import type { AnthropicSubscriptionCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { accountDirFor } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";
import { SCRIPTED_PROVIDER } from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import {
	loaded,
	loginWith,
	staleEntry,
	twoSignedInAccounts,
	writeStale,
} from "../../support/claude-cli-stale-writer.ts";
import { cleanupFakeClaudeCliLogins } from "../../support/fake-claude-cli-login.ts";

const MODEL_BLOCKS = { "claude-opus": { blockedUntil: 4_102_444_000_000, blockReason: "rate_limit" } };

afterEach(() => {
	cleanupFakeClaudeCliLogins();
});

describe("senpi#5594 the account dir record follows a rename", () => {
	it("a stale writer that drops a renamed account relinks it under the renamed display name", async () => {
		const { authPath, storage, signedIn } = await twoSignedInAccounts();
		await renameCredentialAccount(storage, SCRIPTED_PROVIDER, "second", "Work laptop");
		writeStale(authPath, staleEntry("default"));

		const second = loaded(authPath).find((slot) => slot.name === "second");

		expect(second).toMatchObject({ dirId: signedIn[1]?.dirId, displayName: "Work laptop" });
		expect(second?.signInRequired).toBeUndefined();
	});

	it("the record's display name wins over the older label a stale writer still holds, and clear-name sticks", async () => {
		const { authPath, storage } = await twoSignedInAccounts();
		await renameCredentialAccount(storage, SCRIPTED_PROVIDER, "default", "Personal");
		await renameCredentialAccount(storage, SCRIPTED_PROVIDER, "second", "Work laptop");
		await renameCredentialAccount(storage, SCRIPTED_PROVIDER, "default", null);
		writeStale(authPath, staleEntry({ name: "default", displayName: "Old" }, { name: "second", displayName: "Old" }));

		const accounts = loaded(authPath);

		expect(accounts.map((slot) => [slot.name, slot.displayName])).toEqual([
			["default", undefined],
			["second", "Work laptop"],
		]);
	});
});

describe("senpi#5594 concurrent writers and a re-login keep both accounts", () => {
	it("a re-login racing a rename and a block write from a second process keeps both accounts on their own dirs", async () => {
		const { cli, agentDir, authPath, storage, signedIn } = await twoSignedInAccounts();
		const [oldDefault, second] = signedIn;
		const otherProcess = AuthStorage.create(authPath);

		await Promise.all([
			loginWith(storage, cli)("default"),
			renameCredentialAccount(otherProcess, SCRIPTED_PROVIDER, "second", "Work laptop"),
			otherProcess.modify(SCRIPTED_PROVIDER, async (current) => {
				const credential = current as AnthropicSubscriptionCredential;
				return {
					...credential,
					accounts: (credential.accounts ?? []).map((slot) =>
						slot.name === "second" ? { ...slot, modelBlocks: MODEL_BLOCKS } : slot,
					),
				};
			}),
		]);

		const accounts = loaded(authPath);
		const newDefault = accounts.find((slot) => slot.name === "default");
		expect(accounts.map((slot) => slot.name)).toEqual(["default", "second"]);
		expect(newDefault?.dirId).not.toBe(oldDefault?.dirId);
		expect(existsSync(accountDirFor(agentDir, newDefault?.dirId as string))).toBe(true);
		expect(existsSync(accountDirFor(agentDir, oldDefault?.dirId as string))).toBe(false);
		expect(accounts.find((slot) => slot.name === "second")).toMatchObject({
			dirId: second?.dirId,
			displayName: "Work laptop",
			modelBlocks: MODEL_BLOCKS,
		});

		writeStale(authPath, staleEntry("default"));
		expect(loaded(authPath).map((slot) => [slot.name, slot.dirId, slot.signInRequired])).toEqual([
			["default", newDefault?.dirId, undefined],
			["second", second?.dirId, undefined],
		]);
	});
});
