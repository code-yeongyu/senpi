import { createModels, createProvider, type OAuthAuth } from "@earendil-works/pi-ai";
import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import accountExtension from "../../../src/core/extensions/builtin/account/index.ts";
import { registerClaudeAccountCommand } from "../../../src/core/extensions/builtin/claude-sdk-oauth/account-command.ts";
import type { ClaudeSdkOauthCredential } from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";
import gptAccountExtension from "../../../src/core/extensions/builtin/gpt-account.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { accountFooterSuffix } from "../../../src/modes/interactive/components/footer.ts";
import { composedProvider } from "../../support/claude-sdk-oauth-provider.ts";
import { type Command, createAccountCommandContext } from "../account-command-harness.ts";

const fresh = { type: "oauth" as const, access: "fake-access", refresh: "fake-refresh", expires: 4102444800000 };
const flow: OAuthAuth = {
	name: "Fake",
	login: async () => fresh,
	refresh: async (current) => current,
	toAuth: async (current) => ({ apiKey: current.access }),
};
function command(name: string): Command {
	const commands = new Map<string, Command>();
	const pi = {
		registerCommand: (key: string, value: Command) => commands.set(key, value),
		registerFlag: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	gptAccountExtension(pi);
	registerClaudeAccountCommand(pi, { loadSettings: () => ({}), environment: () => undefined });
	accountExtension(pi);
	return commands.get(name)!;
}

// senpi#1495: all account commands address IDs; only labels change.
describe.each([
	["gpt-account", "openai-codex", ""],
	["claude-account", "claude-sdk-oauth", ""],
	["account", "openai-codex", "openai-codex "],
])("/%s display names", (name, provider, prefix) => {
	it("renames multi-word labels, lists safely, pins by ID, and clears metadata", async () => {
		const storage = AuthStorage.inMemory({
			[provider]: {
				...fresh,
				accounts: [
					{ ...fresh, name: "default", source: "login" },
					{ ...fresh, name: "second", source: "login" },
				],
			},
		});
		const { ctx, notices } = createAccountCommandContext(storage, "/tmp");
		const handler = command(name).handler;
		await handler(`${prefix}rename second   Work account  `, ctx);
		expect(listSlots(storage.get(provider))[1].displayName).toBe("Work account");
		await handler(`${prefix}list`, ctx);
		expect(notices.at(-1)?.message).toContain("Work account (second)");
		expect(JSON.stringify(notices)).not.toContain("fake-");
		await handler(`${prefix}pin Work account`, ctx);
		expect(storage.get(provider)).not.toHaveProperty("pinned");
		await handler(`${prefix}pin second`, ctx);
		expect(storage.get(provider)).toHaveProperty("pinned", "second");
		expect(accountFooterSuffix(storage.get(provider), "session-01")).toBe("@Work account (second)");
		await handler(`${prefix}clear-name second`, ctx);
		expect(listSlots(storage.get(provider))[1]).not.toHaveProperty("displayName");
	});

	it("rejects missing names and duplicates without changing the credential", async () => {
		const storage = AuthStorage.inMemory({
			[provider]: {
				...fresh,
				accounts: [
					{ ...fresh, name: "default", source: "login", displayName: "Personal" },
					{ ...fresh, name: "second", source: "login" },
				],
			},
		});
		const before = JSON.stringify(storage.get(provider));
		const { ctx, notices } = createAccountCommandContext(storage, "/tmp");
		for (const args of ["rename second", "rename second personal", "rename missing Valid", "clear-name missing"]) {
			await command(name).handler(prefix + args, ctx);
			expect(notices.at(-1)?.type).toBe("error");
			expect(JSON.stringify(storage.get(provider))).toBe(before);
		}
	});
});

// The offer is gated on the receipt's `origin`: only a machine-generated id
// (the OpenAI lane) gets the display-name dialog. The Claude lane names
// accounts through its own prompt and must never produce a second name dialog.
describe("openai-codex optional post-login naming", () => {
	it.each(["Work account", "", undefined])(
		"names a machine-generated slot after persistence; cancellation keeps login usable (%s)",
		async (answer) => {
			const storage = AuthStorage.inMemory();
			const models = createModels({ credentials: storage });
			models.setProvider(
				createProvider({
					id: "openai-codex",
					name: "Fake",
					baseUrl: "https://example.invalid",
					auth: { oauth: flow },
					models: [],
					api: {},
				}),
			);
			let persistedAtPrompt = false;
			const { ctx, notices, dialogs } = createAccountCommandContext(storage, "/tmp", {
				dialogs: {
					input: async () => {
						persistedAtPrompt = storage.has("openai-codex");
						return answer;
					},
				},
			});
			Object.assign(ctx.modelRegistry, { modelRuntime: models });
			await command("gpt-account").handler("add", ctx);
			expect(persistedAtPrompt).toBe(true);
			expect(dialogs).toHaveLength(1);
			expect(listSlots(storage.get("openai-codex"))).toMatchObject([{ name: "default", access: fresh.access }]);
			expect(listSlots(storage.get("openai-codex"))[0].displayName).toBe(answer || undefined);
			expect(notices.filter((notice) => notice.type === "error")).toEqual([]);
		},
	);
});

// senpi#1495 review finding 6: `/claude-account add` used to ask for a name
// twice - once through the lane's own account-name prompt (when an account
// already exists) and once through the display-name offer. Gating the offer on
// the receipt's origin keeps the lane at exactly one prompt.
describe("claude-sdk-oauth post-login naming", () => {
	it("asks for the account name exactly once per login and never offers a display name", async () => {
		const storage = AuthStorage.inMemory();
		const models = createModels({ credentials: storage });
		models.setProvider(
			composedProvider(async () => false, {
				oauth: createOAuthConfig({
					readCurrent: async () => storage.get("claude-sdk-oauth") as ClaudeSdkOauthCredential | undefined,
					loginFlow: flow,
				}),
			}),
		);
		const { ctx, dialogs } = createAccountCommandContext(storage, "/tmp", {
			dialogs: { input: async () => "Work" },
		});
		Object.assign(ctx.modelRegistry, { modelRuntime: models });
		const handler = command("claude-account").handler;
		await handler("add", ctx); // empty pool: the adapter picks "default", zero prompts
		expect(dialogs).toHaveLength(0);
		expect(listSlots(storage.get("claude-sdk-oauth")).map((slot) => slot.name)).toEqual(["default"]);
		await handler("add", ctx); // existing account: the lane prompts for the id, once
		expect(dialogs).toHaveLength(1);
		expect(listSlots(storage.get("claude-sdk-oauth")).map((slot) => slot.name)).toEqual(["default", "Work"]);
		for (const slot of listSlots(storage.get("claude-sdk-oauth"))) {
			expect(slot).not.toHaveProperty("displayName");
		}
	});
});
