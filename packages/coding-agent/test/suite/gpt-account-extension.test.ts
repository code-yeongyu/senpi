import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { CredentialAccountSummary } from "../../src/core/credential-accounts.ts";
import gptAccountExtension from "../../src/core/extensions/builtin/gpt-account.ts";
import { createRpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { type Command, createAccountCommandContext, registerCommand } from "./account-command-harness.ts";
import { makeHarness, makeSink } from "./rpc-connection-harness.ts";

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
	// #5003 W12: TUI and get_provider_accounts consume the same secret-free summary.
	it("lists mixed registrations with their route and plan permission", async () => {
		const harness = makeHarness(dir);
		storage = harness.authStorage;
		const collected = makeSink();
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		try {
			await storage.modify("chatgpt-subscription", async () => ({
				type: "oauth",
				access: "synthetic-legacy",
				refresh: "synthetic-legacy-refresh",
				expires: 1,
				accounts: [
					{ name: "default", access: "synthetic-legacy", refresh: "synthetic-legacy-refresh", expires: 1 },
					{
						name: "login-2",
						route: "siwc",
						email: "same@example.test",
						access: "synthetic-one",
						refresh: "synthetic-one-refresh",
						expires: 1,
						planUsageEnabled: true,
					},
					{
						name: "login-3",
						route: "siwc",
						email: "same@example.test",
						access: "synthetic-two",
						refresh: "synthetic-two-refresh",
						expires: 1,
						planUsageEnabled: false,
					},
				],
			}));
			const received = collected.waitFor((message) => message.id === "siwc-accounts");
			await handler.handleInputLine(
				JSON.stringify({
					id: "siwc-accounts",
					type: "get_provider_accounts",
					provider: "chatgpt-subscription",
				}),
			);
			const response = await received;
			expect(response.success).toBe(true);
			const listing = response.data as { accounts: CredentialAccountSummary[] };
			expect(listing.accounts).toMatchObject([
				{ name: "default", route: "legacy" },
				{ name: "login-2", route: "siwc", planUsageEnabled: true },
				{ name: "login-3", route: "siwc", planUsageEnabled: false },
			]);
			const { ctx, notices } = createContext();
			await registeredGptCommand().handler("", ctx);
			const lines = notices.at(-1)!.message.split("\n");
			for (const account of listing.accounts) {
				const line = lines.find((candidate) => candidate.includes(`${account.name} |`));
				expect(line).toContain(account.route === "siwc" ? "SIWC" : "legacy");
			}
			expect(lines.find((line) => line.includes("login-3 |"))).toContain(
				"plan usage not enabled: enable it or use an API key",
			);
			expect(notices.at(-1)!.message).toContain("https://chatgpt.com/settings/usage");
			expect(JSON.stringify(listing)).not.toContain("synthetic-");
		} finally {
			await handler.dispose();
			harness.cleanup();
		}
	});

	it("lists ChatGPT Subscription OAuth accounts without leaking tokens", async () => {
		await seedCodexPool();
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("", ctx);

		const output = notices.map((notice) => notice.message).join("\n");
		expect(output).toContain("ChatGPT Subscription OAuth accounts:");
		expect(output).toContain("default | login | available");
		expect(output).toContain("work | login | available");
		expect(output).not.toContain("access-secret");
		expect(output).not.toContain("work-access");
	});

	it("pins and unpins an ChatGPT Subscription OAuth account", async () => {
		await seedCodexPool();
		const { ctx, notices } = createContext();
		const command = registeredGptCommand();

		await command.handler("pin work", ctx);
		await command.handler("", ctx);
		expect(notices[notices.length - 1]?.message).toContain("work | login | available | pinned");

		await command.handler("unpin", ctx);
		expect(storage.get("chatgpt-subscription")).not.toHaveProperty("pinned");
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
