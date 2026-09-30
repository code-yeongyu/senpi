import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { getCredentialAccounts } from "../../src/core/credential-accounts.ts";
import gptAccountExtension from "../../src/core/extensions/builtin/gpt-account.ts";
import { type Command, createAccountCommandContext, registerCommand } from "./account-command-harness.ts";

let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gpt-account-extension-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function registeredGptCommand(): Command {
	return registerCommand("gpt-account", gptAccountExtension);
}

function createContext() {
	return createAccountCommandContext(storage, dir);
}

async function currentPin(): Promise<string | undefined> {
	const accounts = await getCredentialAccounts(storage, "chatgpt-subscription");
	return accounts.find((account) => account.pinned)?.name;
}

async function seedCodexPool(): Promise<void> {
	await storage.modify("chatgpt-subscription", async () => ({
		type: "oauth",
		access: "access-secret",
		refresh: "refresh-secret",
		expires: 1,
		accounts: [
			{ name: "default", access: "access-secret", refresh: "refresh-secret", expires: 1, source: "login" },
			{ name: "work", access: "work-access", refresh: "work-refresh", expires: 1, source: "login" },
		],
	}));
}

describe("/gpt-account command", () => {
	it("lists ChatGPT Subscription OAuth accounts without leaking tokens", async () => {
		await seedCodexPool();
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("", ctx);

		const output = notices.map((notice) => notice.message).join("\n");
		expect(output).toContain("ChatGPT Subscription OAuth accounts:");
		expect(output).toContain("default");
		expect(output).toContain("work");
		expect(output).not.toContain("access-secret");
		expect(output).not.toContain("work-access");
	});

	it("pins and unpins an ChatGPT Subscription OAuth account", async () => {
		await seedCodexPool();
		const { ctx, notices } = createContext();
		const command = registeredGptCommand();

		await command.handler("pin work", ctx);
		await command.handler("", ctx);
		expect(await currentPin()).toBe("work");
		expect(notices[notices.length - 1]?.message).toContain("work");

		await command.handler("unpin", ctx);
		expect(storage.get("chatgpt-subscription")).not.toHaveProperty("pinned");
	});

	it("pins a uniquely named profile without changing its immutable slot ID", async () => {
		await seedCodexPool();
		await storage.modify("chatgpt-subscription", async (current) => {
			if (!current) throw new Error("Missing test credential");
			return {
				...current,
				accounts: listSlots(current).map((slot) =>
					slot.name === "work" ? { ...slot, displayName: "Research Desk" } : slot,
				),
			};
		});
		const { ctx } = createContext();

		await registeredGptCommand().handler("pin research desk", ctx);

		expect(await currentPin()).toBe("work");
	});

	it("refuses an ambiguous profile name and keeps the existing pin", async () => {
		await seedCodexPool();
		await storage.modify("chatgpt-subscription", async (current) => {
			if (!current) throw new Error("Missing test credential");
			return {
				...current,
				pinned: "default",
				accounts: listSlots(current).map((slot) => ({ ...slot, displayName: "research" })),
			};
		});
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("pin research", ctx);

		expect(await currentPin()).toBe("default");
		expect(notices.at(-1)?.type).toBe("error");
		expect(notices.at(-1)?.message).toContain("default");
		expect(notices.at(-1)?.message).toContain("work");
	});

	it("pins the same account by verified email or unique email local part", async () => {
		await storage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			access: "fake-personal-access",
			refresh: "fake-personal-refresh",
			expires: 1,
			accounts: [
				{ name: "default", access: "fake-personal-access", refresh: "fake-personal-refresh", expires: 1 },
				{
					name: "login-2",
					access: "fake-research-access",
					refresh: "fake-research-refresh",
					expires: 1,
					verifiedIdentity: {
						userId: "user-research",
						workspaceId: "account-research",
						verifiedEmail: "research@astrabit.io",
					},
				},
			],
		}));
		const { ctx } = createContext();
		const command = registeredGptCommand();

		await command.handler("pin research@astrabit.io", ctx);
		expect(await currentPin()).toBe("login-2");
		await command.handler("unpin", ctx);
		await command.handler("pin research", ctx);
		expect(await currentPin()).toBe("login-2");
	});

	it("does not select between two verified accounts with the same email local part", async () => {
		await storage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			access: "fake-personal-access",
			refresh: "fake-personal-refresh",
			expires: 1,
			pinned: "default",
			accounts: [
				{ name: "default", access: "fake-personal-access", refresh: "fake-personal-refresh", expires: 1 },
				{
					name: "login-2",
					access: "fake-first-access",
					refresh: "fake-first-refresh",
					verifiedIdentity: {
						userId: "user-1",
						workspaceId: "account-1",
						verifiedEmail: "research@astrabit.io",
					},
				},
				{
					name: "login-3",
					access: "fake-second-access",
					refresh: "fake-second-refresh",
					verifiedIdentity: {
						userId: "user-2",
						workspaceId: "account-2",
						verifiedEmail: "research@other.io",
					},
				},
			],
		}));
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("pin research", ctx);

		expect(await currentPin()).toBe("default");
		expect(notices.at(-1)?.type).toBe("error");
		expect(notices.at(-1)?.message).toContain("login-2");
		expect(notices.at(-1)?.message).toContain("login-3");
	});

	it("remove deletes exactly the named account", async () => {
		await seedCodexPool();
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("remove work", ctx);

		expect(notices.at(-1)?.message).toContain("Removed ChatGPT Subscription OAuth account 'work'");
		expect(storage.listSlots("chatgpt-subscription").map((slot) => slot.name)).toEqual(["default"]);
	});

	it("remove default on a promoted pool leaves the survivor as the stored top-level credential", async () => {
		// The shape appendLoginSlot writes when a legacy flat openai-codex credential
		// gains a second login: the flat fields still project the legacy `default`.
		await storage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			access: "legacy-access",
			refresh: "legacy-refresh",
			expires: 1,
			accounts: [
				{ name: "default", access: "legacy-access", refresh: "legacy-refresh", expires: 1, source: "login" },
				{ name: "login-2", access: "second-access", refresh: "second-refresh", expires: 2, source: "login" },
			],
		}));
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("remove default", ctx);

		expect(notices.at(-1)?.message).toContain("Removed ChatGPT Subscription OAuth account 'default'");
		expect(storage.listSlots("chatgpt-subscription").map((slot) => slot.name)).toEqual(["login-2"]);
		expect(storage.get("chatgpt-subscription")).toMatchObject({
			type: "oauth",
			access: "second-access",
			refresh: "second-refresh",
			expires: 2,
		});
	});

	it("remove without a name reports usage instead of removing anything", async () => {
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("remove", ctx);

		expect(notices.at(-1)?.type).toBe("error");
		expect(notices.at(-1)?.message).toContain("Usage: /gpt-account");
	});
});
