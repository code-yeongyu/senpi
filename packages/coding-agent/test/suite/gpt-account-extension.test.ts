import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	type OAuthCredential,
	type OAuthAuth,
	type Api,
	type Model,
	type TranscriptContext,
	type StreamOptions,
	type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { projectSlot } from "@earendil-works/pi-ai/auth/pool/slots";
import { openaiChatGPTOAuth } from "@earendil-works/pi-ai/auth/oauth/openai-chatgpt";
import { chatgptSubscriptionProvider } from "@earendil-works/pi-ai/providers/chatgpt-subscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { type CredentialAccountSummary, getCredentialAccounts } from "../../src/core/credential-accounts.ts";
import { CredentialSlotRepository } from "../../src/core/credential-pool/state-store.ts";
import gptAccountExtension from "../../src/core/extensions/builtin/gpt-account.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createRpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { type Command, createAccountCommandContext, registerCommand } from "./account-command-harness.ts";
import { makeHarness, makeSink, MockAssistantStream } from "./rpc-connection-harness.ts";

let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gpt-account-extension-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
});

afterEach(() => {
	vi.restoreAllMocks();
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
	const providerId = "chatgpt-subscription";
	async function seedSiwc() {
		const first: OAuthCredential = {
			type: "oauth",
			route: "siwc",
			issuer: "https://auth.openai.com",
			subject: "one",
			clientId: "oaiapp_one",
			access: "synthetic-one",
			refresh: "synthetic-one-refresh",
			expires: 4102444800000,
			planUsageEnabled: true,
		};
		await storage.modify(providerId, async () => ({
			...first,
			order: ["default", "work"],
			accounts: [
				{ ...first, name: "default", source: "login" },
				{
					...first,
					name: "work",
					subject: "two",
					clientId: "oaiapp_two",
					access: "synthetic-two",
					refresh: "synthetic-two-refresh",
					source: "login",
				},
			],
		}));
	}

	it.each(["revoked", "remote_revocation_unconfirmed"] as const)(
		"signs out only the selected account through the revoke hook (%s)",
		async (status) => {
			await seedSiwc();
			const sibling = projectSlot(storage.get(providerId), "default");
			const revoke = vi.spyOn(openaiChatGPTOAuth, "revoke").mockResolvedValue({ status });
			const runtime = await ModelRuntime.create({
				credentials: storage,
				modelsPath: null,
				agentDir: dir,
				allowModelNetwork: false,
			});
			await runtime.registerNativeProvider(chatgptSubscriptionProvider());
			const { ctx, notices } = createContext();
			Object.assign(ctx.modelRegistry, { modelRuntime: runtime });
			await registeredGptCommand().handler("signout work", ctx);
			expect(revoke).toHaveBeenCalledOnce();
			expect(revoke.mock.calls[0][0]).toMatchObject({ subject: "two", clientId: "oaiapp_two" });
			expect(projectSlot(storage.get(providerId), "default")).toEqual(sibling);
			expect(projectSlot(storage.get(providerId), "work")).toMatchObject({
				clientId: "oaiapp_two",
				subject: "two",
				signedOut: true,
				access: "",
				refresh: "",
			});
			expect(notices.at(-1)?.type).toBe(status === "revoked" ? "info" : "warning");
			if (status !== "revoked")
				expect(notices.at(-1)?.message).toContain(
					"remote revocation not confirmed; disconnect the app in ChatGPT Settings",
				);
			await registeredGptCommand().handler("list", ctx);
			expect(notices.at(-1)?.message).toContain("work | login | signed out");
		},
	);

	it("forwards selected logout options and the revocation result through ModelRuntime", async () => {
		await seedSiwc();
		const revoke = vi
			.spyOn(openaiChatGPTOAuth, "revoke")
			.mockResolvedValue({ status: "remote_revocation_unconfirmed" });
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsPath: null,
			agentDir: dir,
			allowModelNetwork: false,
		});
		await runtime.registerNativeProvider(chatgptSubscriptionProvider());
		expect(await runtime.logout(providerId, { slotId: "work" })).toEqual({ status: "remote_revocation_unconfirmed" });
		expect(revoke).toHaveBeenCalledOnce();
		expect(projectSlot(storage.get(providerId), "default")).toMatchObject({ access: "synthetic-one" });
		expect(runtime.hasConfiguredAuth(providerId)).toBe(true);
	});

	it.each(["stream", "streamSimple"] as const)(
		"shares actual active and paused accounts with RPC after %s failover",
		async (method) => {
			const harness = makeHarness(dir);
			storage = harness.authStorage;
			const runtime = harness.runtimeHost.session.modelRuntime;
			const collected = makeSink();
			const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
			try {
				await seedSiwc();
				const faux = fauxProvider({ provider: providerId });
				const attempts: (string | undefined)[] = [];
				const send = (_model: Model<Api>, _context: TranscriptContext, options?: StreamOptions) => {
					attempts.push(options?.apiKey);
					const result = new MockAssistantStream();
					queueMicrotask(() => {
						if (options?.apiKey === "synthetic-one")
							result.push({
								type: "error",
								reason: "error",
								error: {
									...fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic usage pause" }),
									providerDiagnostic: {
										category: "quota",
										evidence: "structured_code",
										code: "subscription_sharing_usage_limit_exceeded",
										httpStatus: 429,
									},
								},
							});
						else result.push({ type: "done", reason: "stop", message: fauxAssistantMessage("ok") });
					});
					return result;
				};
				await runtime.registerNativeProvider({
					...faux.provider,
					stream: send,
					streamSimple: send,
					auth: {
						oauth: {
							...chatgptSubscriptionProvider().auth.oauth!,
							toAuth: async (credential) => ({ apiKey: credential.access }),
						},
					},
				});
				await runtime.refresh({ allowNetwork: false });
				const sessionId = harness.runtimeHost.session.sessionManager.getSessionId();
				const source = runtime[method](faux.getModel(), { messages: [] }, { sessionId });
				let terminal: AssistantMessageEvent | undefined;
				for await (const event of source) {
					if (event.type === "done" || event.type === "error") {
						terminal = event;
						break;
					}
				}
				expect({ attempts, terminal: terminal?.type === "error" ? terminal.error : terminal?.type }).toEqual({
					attempts: ["synthetic-one", "synthetic-two"],
					terminal: "done",
				});
				const received = collected.waitFor((message) => message.id === "part2-list");
				await handler.handleInputLine(
					JSON.stringify({ id: "part2-list", type: "get_provider_accounts", provider: providerId }),
				);
				const response = await received;
				expect(response.success).toBe(true);
				const accounts = (response.data as { accounts: CredentialAccountSummary[] }).accounts;
				expect(accounts).toMatchObject([
					{ name: "default", paused: true, active: false },
					{ name: "work", active: true },
				]);
				expect(accounts[0]).not.toHaveProperty("blockedUntil");
				expect(accounts[0]).toHaveProperty("usageUrl", "https://chatgpt.com/settings/usage");
				const { ctx, notices } = createContext();
				Object.assign(ctx.modelRegistry, { modelRuntime: runtime });
				Object.assign(ctx.sessionManager, { getSessionId: () => sessionId });
				await registeredGptCommand().handler("list", ctx);
				const lines = notices.at(-1)!.message.split("\n");
				expect(lines.find((line) => line.includes("default |"))).toContain("paused");
				expect(lines.find((line) => line.includes("work |"))).toContain("active");
				expect(lines.find((line) => line.includes("default |"))).not.toMatch(/until|reset|\d{4}-\d{2}/);
				expect(JSON.stringify(accounts)).not.toContain("synthetic-");
			} finally {
				await handler.dispose();
				harness.cleanup();
			}
		},
	);

	it("returns the same selected signout result over the real RPC handler", async () => {
		const harness = makeHarness(dir);
		storage = harness.authStorage;
		const collected = makeSink();
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		try {
			await seedSiwc();
			const revoke = vi
				.spyOn(openaiChatGPTOAuth, "revoke")
				.mockResolvedValue({ status: "remote_revocation_unconfirmed" });
			await harness.runtimeHost.session.modelRuntime.registerNativeProvider(chatgptSubscriptionProvider());
			const received = collected.waitFor((message) => message.id === "part2-logout");
			await handler.handleInputLine(
				JSON.stringify({ id: "part2-logout", type: "logout", provider: providerId, slotId: "work" }),
			);
			expect(await received).toMatchObject({ success: true, data: { status: "remote_revocation_unconfirmed" } });
			expect(revoke).toHaveBeenCalledOnce();
			expect(projectSlot(storage.get(providerId), "work")).toMatchObject({
				signedOut: true,
				clientId: "oaiapp_two",
			});
			expect(projectSlot(storage.get(providerId), "default")).toMatchObject({ access: "synthetic-one" });
		} finally {
			await handler.dispose();
			harness.cleanup();
		}
	});

	it("reauthorizes the selected RPC account through the same validated login", async () => {
		const harness = makeHarness(dir);
		storage = harness.authStorage;
		const collected = makeSink();
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		try {
			await seedSiwc();
			const selected = projectSlot(storage.get(providerId), "work");
			const login = vi.fn<OAuthAuth["login"]>(async (_interaction, options) => {
				expect(options?.reauthorize).toEqual(selected);
				if (selected?.type !== "oauth") throw new Error("missing fixture");
				return { ...selected, access: "synthetic-reauthorized" };
			});
			const provider = chatgptSubscriptionProvider();
			await harness.runtimeHost.session.modelRuntime.registerNativeProvider({
				...provider,
				auth: { oauth: { ...provider.auth.oauth!, login } },
			});
			const ended = collected.waitFor((message) => message.type === "auth_login_end");
			await handler.handleInputLine(
				JSON.stringify({ id: "part2-reauthorize", type: "login_start", provider: providerId, slotId: "work" }),
			);
			expect(await ended).toMatchObject({ success: true });
			expect(login).toHaveBeenCalledOnce();
			expect(projectSlot(storage.get(providerId), "work")).toMatchObject({ access: "synthetic-reauthorized" });
			expect(projectSlot(storage.get(providerId), "default")).toMatchObject({ access: "synthetic-one" });
		} finally {
			await handler.dispose();
			harness.cleanup();
		}
	});

	it("tracks one SIWC account's pause until a successful probe without presenting a reset", async () => {
		await seedSiwc();
		await storage.modify(providerId, async (current) => {
			const selected = projectSlot(current, "default");
			if (!selected) throw new Error("missing fixture");
			return selected;
		});
		const faux = fauxProvider({ provider: providerId });
		let limited = true;
		const send = () => {
			const result = new MockAssistantStream();
			queueMicrotask(() => {
				if (limited)
					result.push({
						type: "error",
						reason: "error",
						error: {
							...fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic pause" }),
							providerDiagnostic: {
								category: "quota",
								evidence: "structured_code",
								code: "subscription_sharing_usage_limit_exceeded",
								httpStatus: 429,
							},
						},
					});
				else result.push({ type: "done", reason: "stop", message: fauxAssistantMessage("ok") });
			});
			return result;
		};
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsPath: null,
			agentDir: dir,
			allowModelNetwork: false,
		});
		await runtime.registerNativeProvider({
			...faux.provider,
			stream: send,
			streamSimple: send,
			auth: {
				oauth: {
					...chatgptSubscriptionProvider().auth.oauth!,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
		});
		await runtime.refresh({ allowNetwork: false });
		for await (const event of runtime.stream(faux.getModel(), { messages: [] }, { sessionId: "single" })) {
			if (event.type === "error" || event.type === "done") break;
		}
		const repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
		const before = await getCredentialAccounts(storage, providerId, {}, repository);
		expect(before).toMatchObject([{ name: "default", paused: true, usageUrl: "https://chatgpt.com/settings/usage" }]);
		expect(before[0]).not.toHaveProperty("blockedUntil");
		// The internal probe is due, but no provider has confirmed that the pause lifted.
		await repository.mutateSlotState(providerId, "stored", "default", (current) => ({ ...current, blockedUntil: 1 }));
		expect((await getCredentialAccounts(storage, providerId, {}, repository))[0]).toMatchObject({ paused: true });
		limited = false;
		for await (const event of runtime.streamSimple(faux.getModel(), { messages: [] }, { sessionId: "single" })) {
			if (event.type === "error" || event.type === "done") break;
		}
		expect((await getCredentialAccounts(storage, providerId, {}, repository))[0]).not.toHaveProperty("paused");
	});

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
			const lastNotice = notices.at(-1);
			if (!lastNotice) throw new Error("notice not found");
			const lines = lastNotice.message.split("\n");
			for (const account of listing.accounts) {
				const line = lines.find((candidate) => candidate.includes(`${account.name} |`));
				expect(line).toContain(account.route === "siwc" ? "SIWC" : "legacy");
			}
			expect(lines.find((line) => line.includes("login-3 |"))).toContain(
				"plan usage not enabled: enable it or use an API key",
			);
			expect(lastNotice.message).toContain("https://chatgpt.com/settings/usage");
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
