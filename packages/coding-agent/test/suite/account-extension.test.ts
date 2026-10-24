import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { getCredentialAccounts } from "../../src/core/credential-accounts.ts";
import accountExtension from "../../src/core/extensions/builtin/account/index.ts";
import { promptAccountDisplayName } from "../../src/core/extensions/builtin/account-display-name.ts";
import { type Command, createAccountCommandContext, registerCommand } from "./account-command-harness.ts";

let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "account-extension-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function registeredCommand(): Command {
	return registerCommand("account", accountExtension);
}

function createContext() {
	return createAccountCommandContext(storage, dir);
}

async function seedPool(provider: string): Promise<void> {
	await storage.modify(provider, async () => ({
		type: "api_key",
		key: "key-default",
		accounts: [
			{ name: "default", key: "key-default", source: "login" },
			{ name: "work", key: "key-work", source: "login" },
		],
	}));
}

describe("/account command", () => {
	it("saves an optional custom visible name on the newly committed Anthropic slot", async () => {
		await seedPool("anthropic");
		const context = createAccountCommandContext(storage, dir, {
			dialogs: { input: async () => "Custom Anthropic" },
		});

		await promptAccountDisplayName(context.ctx, {
			providerId: "anthropic",
			name: "work",
			origin: "generated",
		});

		const accounts = await getCredentialAccounts(storage, "anthropic");
		expect(accounts.map(({ name, displayName }) => ({ name, displayName }))).toEqual([
			{ name: "default", displayName: undefined },
			{ name: "work", displayName: "Custom Anthropic" },
		]);
	});

	it.each([undefined, ""])("keeps the saved account when optional naming is dismissed with %s", async (answer) => {
		await seedPool("anthropic");
		const context = createAccountCommandContext(storage, dir, {
			dialogs: { input: async () => answer },
		});
		const before = await getCredentialAccounts(storage, "anthropic");

		await promptAccountDisplayName(context.ctx, {
			providerId: "anthropic",
			name: "work",
			origin: "generated",
		});

		expect(await getCredentialAccounts(storage, "anthropic")).toEqual(before);
	});

	it("completes the Anthropic provider and its action argument", async () => {
		const complete = registeredCommand().getArgumentCompletions;
		expect(await complete?.("anth")).toEqual([{ value: "anthropic", label: "anthropic" }]);
		expect((await complete?.("anthropic "))?.map((item) => item.value)).toEqual([
			"anthropic list",
			"anthropic pin",
			"anthropic unpin",
			"anthropic reset",
			"anthropic remove",
			"anthropic rename",
			"anthropic clear-name",
		]);
		expect(await complete?.("anthropic un")).toEqual([{ value: "anthropic unpin", label: "unpin" }]);
		expect(await complete?.("anthropic pin default")).toBeNull();
		expect(await complete?.("anthropic unknown")).toBeNull();
	});

	it("lists accounts for any provider without leaking key material", async () => {
		await seedPool("openai");
		const { ctx, notices } = createContext();

		await registeredCommand().handler("openai", ctx);

		const output = notices.map((notice) => notice.message).join("\n");
		expect(output).toContain("Credential accounts for openai:");
		expect(output).toContain("default | login | available");
		expect(output).toContain("work | login | available");
		expect(output).not.toContain("key-default");
		expect(output).not.toContain("key-work");
	});

	it("pins, reflects the pin in list output, and unpins", async () => {
		await seedPool("openai");
		const { ctx, notices } = createContext();
		const command = registeredCommand();

		await command.handler("openai pin work", ctx);
		await command.handler("openai list", ctx);
		expect(notices.map((notice) => notice.message).join("\n")).toContain("work | login | available | pinned");

		await command.handler("openai unpin", ctx);
		await command.handler("openai list", ctx);
		expect(notices.at(-1)?.message).not.toContain("pinned");
	});

	it("removes one account and keeps its sibling", async () => {
		await seedPool("openai");
		const { ctx, notices } = createContext();
		const command = registeredCommand();

		await command.handler("openai remove work", ctx);
		await command.handler("openai list", ctx);

		const output = notices.at(-1)?.message ?? "";
		expect(output).toContain("default");
		expect(output).not.toContain("work");
	});

	it("reports errors as notifications instead of crashing", async () => {
		await seedPool("openai");
		const { ctx, notices } = createContext();

		await registeredCommand().handler("openai pin missing", ctx);

		expect(notices.at(-1)).toEqual({ message: "Provider account not found: missing", type: "error" });
	});

	it("shows usage without a provider argument", async () => {
		const { ctx, notices } = createContext();

		await registeredCommand().handler("", ctx);

		expect(notices.at(-1)?.type).toBe("error");
		expect(notices.at(-1)?.message).toContain("Usage: /account");
	});

	it("lets the Anthropic menu pin and unpin a selected account", async () => {
		await seedPool("anthropic");
		const selections = [
			"2. work | login | available",
			"Pin",
			"2. work | login | available | pinned",
			"Unpin",
			"Back",
		];
		const context = createAccountCommandContext(storage, dir, {
			dialogs: { select: () => selections.shift() },
		});

		await registeredCommand().handler("anthropic", context.ctx);

		const accounts = await getCredentialAccounts(storage, "anthropic");
		expect(accounts.find((account) => account.name === "work")?.pinned).toBe(false);
		expect(context.dialogs.map((dialog) => dialog.kind)).toEqual(["select", "select", "select", "select", "select"]);
		expect(context.dialogs.some((dialog) => dialog.kind === "select" && dialog.options.includes("Remove"))).toBe(
			true,
		);
		expect(JSON.stringify(context.dialogs)).not.toContain("key-work");
	});

	it("renames the display name without changing the account slot", async () => {
		await seedPool("anthropic");
		const selections = ["2. work | login | available", "Rename", "Back"];
		const context = createAccountCommandContext(storage, dir, {
			dialogs: {
				select: () => selections.shift(),
				input: async () => "Work laptop",
			},
		});

		await registeredCommand().handler("anthropic", context.ctx);

		const accounts = await getCredentialAccounts(storage, "anthropic");
		expect(accounts.find((account) => account.name === "work")).toMatchObject({
			name: "work",
			displayName: "Work laptop",
		});
		expect(context.dialogs.some((dialog) => dialog.kind === "input")).toBe(true);
	});

	it("requires confirmation before removing a selected account", async () => {
		await seedPool("anthropic");
		const selections = ["2. work | login | available", "Remove", "Back"];
		const context = createAccountCommandContext(storage, dir, {
			dialogs: {
				select: () => selections.shift(),
				confirm: () => false,
			},
		});

		await registeredCommand().handler("anthropic", context.ctx);

		expect((await getCredentialAccounts(storage, "anthropic")).map((account) => account.name)).toContain("work");
		expect(context.dialogs.some((dialog) => dialog.kind === "confirm")).toBe(true);
	});

	it("removes a selected account only after confirmation", async () => {
		await seedPool("anthropic");
		const selections = ["2. work | login | available", "Remove", "Back"];
		const context = createAccountCommandContext(storage, dir, {
			dialogs: {
				select: () => selections.shift(),
				confirm: () => true,
			},
		});

		await registeredCommand().handler("anthropic", context.ctx);

		expect((await getCredentialAccounts(storage, "anthropic")).map((account) => account.name)).not.toContain("work");
	});

	it("returns safely when account or action selection is cancelled", async () => {
		await seedPool("anthropic");
		const context = createAccountCommandContext(storage, dir, {
			dialogs: { select: () => undefined },
		});

		await registeredCommand().handler("anthropic", context.ctx);

		expect(context.dialogs).toHaveLength(1);
		expect((await getCredentialAccounts(storage, "anthropic")).map((account) => account.name)).toEqual([
			"default",
			"work",
		]);
	});

	it("keeps provider-only invocation as text output outside the TUI", async () => {
		await seedPool("anthropic");
		const context = createAccountCommandContext(storage, dir, { mode: "print" });

		await registeredCommand().handler("anthropic", context.ctx);

		expect(context.dialogs).toHaveLength(0);
		expect(context.notices[context.notices.length - 1]?.message).toContain("Credential accounts for anthropic:");
	});

	it("guides an empty Anthropic pool to login", async () => {
		const context = createAccountCommandContext(storage, dir);

		await registeredCommand().handler("anthropic", context.ctx);

		expect(context.notices[context.notices.length - 1]?.message).toContain("Use /login");
		expect(context.dialogs).toHaveLength(0);
	});
});
