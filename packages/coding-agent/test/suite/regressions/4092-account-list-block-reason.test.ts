import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { formatAccountRetryTime } from "../../../src/core/credential-account-status.ts";
import { credentialPoolRepository } from "../../../src/core/credential-accounts.ts";
import accountExtension from "../../../src/core/extensions/builtin/account/index.ts";
import { registerClaudeAccountCommand } from "../../../src/core/extensions/builtin/anthropic-subscription/account-command.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import gptAccountExtension from "../../../src/core/extensions/builtin/gpt-account.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";
import { type Command, createAccountCommandContext, registerCommand } from "../account-command-harness.ts";

// senpi#4092: every TUI account list says why an account sits out and until when, instead of a bare "blocked".
const UNTIL = Date.now() + 3_600_000;
const RETRY = formatAccountRetryTime(UNTIL);

let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-4092-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

type Health = { blockReason: "rate_limit" | "auth_error" | "account_disabled"; blockedUntil?: number };

async function seedOauthPool(provider: string, health: Record<string, Health>): Promise<void> {
	const names = ["limited", "rejected", "disabled", "healthy"];
	await storage.modify(provider, async () => ({
		type: "oauth",
		access: "limited-access",
		refresh: "limited-refresh",
		expires: 1,
		accounts: names.map((name) => ({
			name,
			access: `${name}-access`,
			refresh: `${name}-refresh`,
			expires: 1,
			source: "login" as const,
		})),
	}));
	const repository = credentialPoolRepository(storage);
	for (const [name, block] of Object.entries(health)) {
		const credentialRevision = await repository.storedCredentialRevision(provider, name, {
			access: `${name}-access`,
			refresh: `${name}-refresh`,
		});
		await repository.mutateSlotState(provider, "stored", name, () => ({ ...block, credentialRevision }));
	}
}

const HEALTH: Record<string, Health> = {
	limited: { blockReason: "rate_limit", blockedUntil: UNTIL },
	rejected: { blockReason: "auth_error", blockedUntil: UNTIL },
	disabled: { blockReason: "account_disabled" },
};

async function listOutput(command: Command, args: string): Promise<string> {
	const { ctx, notices } = createAccountCommandContext(storage, dir);
	await command.handler(args, ctx);
	return notices.map((notice) => notice.message).join("\n");
}

function expectReasons(output: string): void {
	expect(output).toContain(`limited | login | rate limited; retry after ${RETRY}`);
	expect(output).toContain(`rejected | login | sign-in rejected; next check after ${RETRY}`);
	expect(output).toContain("disabled | login | account disabled; needs attention");
	expect(output).toContain("healthy | login | available");
	expect(output).not.toMatch(/\| blocked( \||$)/m);
}

describe("account lists say why an account is blocked and until when (senpi#4092)", () => {
	it("/account <provider> list", async () => {
		await seedOauthPool("chatgpt-subscription", HEALTH);
		expectReasons(await listOutput(registerCommand("account", accountExtension), "chatgpt-subscription"));
	});

	it("/gpt-account", async () => {
		await seedOauthPool("chatgpt-subscription", HEALTH);
		expectReasons(await listOutput(registerCommand("gpt-account", gptAccountExtension), ""));
	});

	it("/claude-account", async () => {
		const slots = [
			{ name: "limited", blockReason: "rate_limit", blockedUntil: UNTIL },
			{ name: "rejected", blockReason: "auth_error", blockedUntil: UNTIL },
			{ name: "disabled", blockReason: "account_disabled" },
			{ name: "healthy" },
		].map(({ name, ...health }) => cliSlot(name, health));
		const credential = slots.reduce((current, slot) => addAccount(current, slot), emptyCredential());
		await storage.modify("anthropic-subscription", async () => credential);
		const commands = new Map<string, Command>();
		const pi = {
			registerCommand: (name: string, command: Command) => commands.set(name, command),
			registerFlag: () => undefined,
			getFlag: () => undefined,
			on: () => undefined,
		} as unknown as ExtensionAPI;
		registerClaudeAccountCommand(pi, { loadSettings: () => ({}), environment: () => undefined });
		const command = commands.get("claude-account");
		if (!command) throw new Error("/claude-account was not registered");
		expectReasons(await listOutput(command, ""));
	});
});
