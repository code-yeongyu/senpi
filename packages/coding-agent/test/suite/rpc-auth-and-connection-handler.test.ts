import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialPoolRepository } from "../../src/core/credential-accounts.ts";
import { SENTINEL_OAUTH_FIELDS } from "../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";
import { RpcClient, RpcCommandError } from "../../src/modes/rpc/rpc-client.ts";
import { socketSink } from "../../src/modes/rpc/socket-sink.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createRpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { createHarness } from "./harness.ts";
import { makeHarness, makeSink } from "./rpc-connection-harness.ts";

describe("RPC auth and connection handler contracts", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `rpc-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	// Desktop #1812: the desktop removes a custom server by deleting its models.json block, then
	// sends logout for that provider. The running host must stop listing its models right away.
	it("stops serving a removed custom provider after logout, without a restart", async () => {
		const collected = makeSink();
		const modelsPath = join(tempDir, "models.json");
		const harness = makeHarness(tempDir, { modelsJsonPath: modelsPath });
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const gpuBox = {
			baseUrl: "http://192.168.1.20:8000/v1",
			api: "openai-completions",
			models: [
				{
					id: "qwen2.5-coder",
					name: "qwen2.5-coder",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32000,
					maxTokens: 4000,
				},
			],
		};
		let request = 0;
		const send = async (command: Record<string, unknown>) => {
			const id = `r${++request}`;
			await handler.handleInputLine(JSON.stringify({ id, ...command }));
			return collected.waitFor((message) => message.id === id, 5_000);
		};
		const servesGpuBox = async () => {
			const response = await send({ type: "get_available_models" });
			const data = response.data as { models: Array<{ provider: string }> };
			return data.models.some((model) => model.provider === "gpu-box");
		};

		writeFileSync(modelsPath, JSON.stringify({ providers: { "gpu-box": gpuBox } }));
		expect(await send({ type: "login_api_key", provider: "gpu-box", key: "synthetic-server-key" })).toMatchObject({
			success: true,
		});
		expect(await servesGpuBox()).toBe(true);

		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		expect(await send({ type: "logout", provider: "gpu-box" })).toMatchObject({ success: true });
		expect(await servesGpuBox()).toBe(false);
		// Losing the key alone hides it from "available"; the models themselves must be gone too,
		// which is what #1812 saw stay listed.
		expect(harness.runtimeHost.session.modelRegistry.getAll().some((model) => model.provider === "gpu-box")).toBe(
			false,
		);
		await handler.dispose();
	});

	it("stops serving a removed keyless custom provider after logout (#1812)", async () => {
		const collected = makeSink();
		const modelsPath = join(tempDir, "models.json");
		const harness = makeHarness(tempDir, { modelsJsonPath: modelsPath });
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const localBox = {
			baseUrl: "http://localhost:8080/v1",
			api: "openai-completions",
			apiKey: "not-needed",
			models: [
				{
					id: "gemma-3",
					name: "gemma-3",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32000,
					maxTokens: 4000,
				},
			],
		};
		let request = 0;
		const send = async (command: Record<string, unknown>) => {
			const id = `k${++request}`;
			await handler.handleInputLine(JSON.stringify({ id, ...command }));
			return collected.waitFor((message) => message.id === id, 5_000);
		};
		const servesLocalBox = async () => {
			const response = await send({ type: "get_available_models" });
			const data = response.data as { models: Array<{ provider: string }> };
			return data.models.some((model) => model.provider === "local-box");
		};

		writeFileSync(modelsPath, JSON.stringify({ providers: { "local-box": localBox } }));
		await harness.runtimeHost.session.modelRegistry.refresh();
		expect(await servesLocalBox()).toBe(true);

		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		expect(await send({ type: "logout", provider: "local-box" })).toMatchObject({ success: true });
		expect(await servesLocalBox()).toBe(false);
		await handler.dispose();
	});

	it("lists authentication providers with their status", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(JSON.stringify({ id: "providers", type: "get_auth_providers" }));
		const response = await collected.waitFor((message) => message.id === "providers");
		expect(response).toMatchObject({ type: "response", command: "get_auth_providers", success: true });
		const data = response.data as { providers: Array<Record<string, unknown>> };
		const anthropic = data.providers.find((provider) => provider.id === "anthropic");
		expect(anthropic).toMatchObject({ authType: "api_key", name: expect.any(String) });
		expect(data.providers.some((provider) => provider.id === "anthropic" && provider.authType === "oauth")).toBe(
			false,
		);
		expect(anthropic?.status).toMatchObject({ configured: expect.any(Boolean) });
		await handler.dispose();
	});

	// senpi#4328 (omo-desktop-app#4711): a provider defined outside the app cannot be deleted in it,
	// so each row says where it is defined.
	it("tells where each listed provider is defined", async () => {
		const customProvider = () => ({
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey: "not-needed",
			models: [
				{
					id: "custom-model",
					name: "custom-model",
					reasoning: false,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32000,
					maxTokens: 4000,
				},
			],
		});
		const harness = await createHarness({
			modelsJson: { providers: { "file-box": customProvider() } },
			extensionFactories: [
				{
					path: "/extensions/proxy-provider.ts",
					factory: (pi) => pi.registerProvider("proxy-box", customProvider()),
				},
				...["anthropic-subscription", "cursor-cli-oauth", "vertex-model-garden"].map((id) => ({
					path: `<builtin:${id}>`,
					factory: (pi: ExtensionAPI) => pi.registerProvider(id, customProvider()),
				})),
				(pi) => pi.registerProvider("inline-box", customProvider()),
				{
					path: "<unknown>",
					factory: (pi) => pi.registerProvider("unknown-box", customProvider()),
				},
			],
		});
		cleanup = harness.cleanup;
		const collected = makeSink();
		const handler = createRpcConnectionHandler(
			{
				session: harness.session,
				setRebindSession: vi.fn(),
				dispose: vi.fn(async () => {}),
			} as unknown as AgentSessionRuntime,
			collected.sink,
		);

		await handler.handleInputLine(JSON.stringify({ id: "origins", type: "get_auth_providers" }));
		const response = await collected.waitFor((message) => message.id === "origins");
		const rows = (response.data as { providers: Array<{ id: string; authType: string; origin?: unknown }> })
			.providers;
		const originOf = (id: string) => rows.find((row) => row.id === id && row.authType === "api_key")?.origin;
		expect(originOf("anthropic")).toEqual({ kind: "builtin" });
		expect(originOf("file-box")).toEqual({
			kind: "models_json",
			modelsJsonPath: join(harness.tempDir, "models.json"),
		});
		expect(originOf("proxy-box")).toEqual({ kind: "extension", extensionPath: "/extensions/proxy-provider.ts" });
		for (const id of ["anthropic-subscription", "cursor-cli-oauth", "vertex-model-garden"]) {
			expect(originOf(id)).toEqual({ kind: "builtin" });
		}
		expect(originOf("inline-box")).toEqual({ kind: "extension" });
		expect(originOf("unknown-box")).toEqual({ kind: "extension" });
		await handler.dispose();
	});

	// #2384 (omo-desktop-app#1315, DESKTOP-30): the OAuth and API-key rows of one provider shared one
	// per-provider status, so a stored Claude login also read as a connected API key.
	it("gives each auth method row of a provider its own status", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const modelRegistry = harness.runtimeHost.session.modelRegistry;
		let request = 0;
		const rowsFor = async (provider: string) => {
			const id = `providers-${++request}`;
			await handler.handleInputLine(JSON.stringify({ id, type: "get_auth_providers" }));
			const response = await collected.waitFor((message) => message.id === id);
			const data = response.data as { providers: Array<{ id: string; authType: string; status: unknown }> };
			return Object.fromEntries(
				data.providers.filter((row) => row.id === provider).map((row) => [row.authType, row.status]),
			);
		};

		harness.authStorage.set("openrouter", {
			type: "oauth",
			access: "scripted-access",
			refresh: "scripted-refresh",
			expires: 4_102_444_800_000,
		});
		await modelRegistry.refresh();
		expect(await rowsFor("openrouter")).toEqual({
			oauth: { configured: true, source: "stored" },
			api_key: { configured: false },
		});

		harness.authStorage.remove("openrouter");
		await handler.handleInputLine(
			JSON.stringify({ id: "key", type: "login_api_key", provider: "openrouter", key: "sk-scripted" }),
		);
		await collected.waitFor((message) => message.id === "key");
		// No refresh here: the login_api_key response itself must mean the status is current.
		expect(await rowsFor("openrouter")).toEqual({
			oauth: { configured: false },
			api_key: { configured: true, source: "stored" },
		});

		await handler.handleInputLine(JSON.stringify({ id: "out", type: "logout", provider: "openrouter" }));
		await collected.waitFor((message) => message.id === "out");
		expect(await rowsFor("openrouter")).toEqual({
			oauth: { configured: false },
			api_key: { configured: false },
		});
		await handler.dispose();
	});

	it("round-trips provider accounts and emits a safe change event after a scripted OAuth add", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		harness.authStorage.registerOAuthProvider(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, {
			name: "Scripted OAuth",
			async login() {
				return {
					type: "oauth",
					access: "claude-sdk-oauth-managed",
					refresh: "claude-sdk-oauth-managed",
					expires: 4_102_444_800_000,
					accounts: [
						{
							name: "default",
							source: "login",
							access: "sk-ant-scripted-access",
							refresh: "scripted-refresh",
							expires: 4_102_444_800_000,
							// senpi#1495 review finding 7: the wire projection must carry
							// displayName for named accounts, with `)`/`:` in the label.
							displayName: "Work: main (client)",
						},
					],
				};
			},
			async refresh(credentials) {
				return credentials;
			},
			async toAuth(credentials) {
				return { apiKey: credentials.access };
			},
		});
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const changed = collected.waitFor((message) => message.type === "auth_accounts_changed");

		await handler.handleInputLine(
			JSON.stringify({ id: "add", type: "login_start", provider: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID }),
		);
		await collected.waitFor((message) => message.type === "auth_login_end" && message.success === true);
		expect(await changed).toEqual({ type: "auth_accounts_changed", provider: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID });

		// Account management is provider-neutral: a provider with no stored
		// credential and no numbered env slots simply has no accounts. It is no
		// longer refused outright, which is what confined pools to one lane.
		await handler.handleInputLine(
			JSON.stringify({ id: "unknown-provider", type: "get_provider_accounts", provider: "unknown-provider" }),
		);
		expect(await collected.waitFor((message) => message.id === "unknown-provider")).toMatchObject({
			success: true,
			command: "get_provider_accounts",
			data: { accounts: [] },
		});

		await handler.handleInputLine(
			JSON.stringify({
				id: "accounts",
				type: "get_provider_accounts",
				provider: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
			}),
		);
		expect(await collected.waitFor((message) => message.id === "accounts")).toMatchObject({
			type: "response",
			command: "get_provider_accounts",
			success: true,
			data: {
				accounts: [
					{ name: "default", displayName: "Work: main (client)", source: "login", blocked: false, pinned: false },
				],
			},
		});
		expect(JSON.stringify(collected.messages())).not.toMatch(/sk-ant/);
		await handler.dispose();
	});

	it("frames login start, URL, and completion as distinct JSONL records", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const loginSpy = vi.spyOn(harness.authStorage, "login").mockImplementation(async (providerId, callbacks) => {
			callbacks.onAuth({ url: "https://stub.example/oauth?code=FAKE" });
			harness.authStorage.set(providerId, {
				type: "oauth",
				access: "FAKE-ACCESS",
				refresh: "FAKE-REFRESH",
				expires: Date.now() + 3_600_000,
			});
		});
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const url = collected.waitFor((message) => message.type === "auth_login_url");
		const end = collected.waitFor((message) => message.type === "auth_login_end");

		await handler.handleInputLine(JSON.stringify({ id: "login", type: "login_start", provider: "anthropic" }));

		expect(await collected.waitFor((message) => message.id === "login")).toMatchObject({
			type: "response",
			command: "login_start",
			success: true,
		});
		expect(await url).toMatchObject({ provider: "anthropic", url: "https://stub.example/oauth?code=FAKE" });
		expect(await end).toMatchObject({ provider: "anthropic", success: true });
		expect(loginSpy).toHaveBeenCalledWith("anthropic", expect.anything());
		await handler.dispose();
	});

	it("frames login failures as a terminal auth event", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		vi.spyOn(harness.authStorage, "login").mockRejectedValue(new Error("oauth port busy"));
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const end = collected.waitFor((message) => message.type === "auth_login_end");

		await handler.handleInputLine(JSON.stringify({ id: "failed-login", type: "login_start", provider: "anthropic" }));

		expect(await collected.waitFor((message) => message.id === "failed-login")).toMatchObject({ success: true });
		expect(await end).toMatchObject({
			provider: "anthropic",
			success: false,
			error: expect.stringContaining("oauth port busy"),
		});
		await handler.dispose();
	});

	it("cancels an in-flight login and emits an unsuccessful terminal event", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		vi.spyOn(harness.authStorage, "login").mockImplementation(async (_providerId, callbacks) => {
			callbacks.onAuth({ url: "https://stub.example/oauth?code=PENDING" });
			await new Promise<void>((_resolve, reject) => {
				callbacks.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
			});
		});
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const url = collected.waitFor((message) => message.type === "auth_login_url");

		await handler.handleInputLine(JSON.stringify({ id: "start", type: "login_start", provider: "anthropic" }));
		await url;
		const end = collected.waitFor((message) => message.type === "auth_login_end");
		await handler.handleInputLine(JSON.stringify({ id: "cancel", type: "login_cancel", provider: "anthropic" }));

		expect(await collected.waitFor((message) => message.id === "cancel")).toMatchObject({ success: true });
		expect(await end).toMatchObject({ provider: "anthropic", success: false });
		await handler.dispose();
	});

	it("stores and removes an API-key credential through RPC commands", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(
			JSON.stringify({ id: "set-key", type: "login_api_key", provider: "openai", key: "sk-FAKEKEY-123" }),
		);
		expect(await collected.waitFor((message) => message.id === "set-key")).toMatchObject({ success: true });
		const stored = JSON.parse(readFileSync(harness.authPath, "utf-8")) as Record<
			string,
			{ type: string; key: string }
		>;
		expect(stored.openai).toMatchObject({ type: "api_key", key: "sk-FAKEKEY-123" });
		expect(statSync(harness.authPath).mode & 0o777).toBe(0o600);

		await handler.handleInputLine(JSON.stringify({ id: "logout", type: "logout", provider: "openai" }));
		expect(await collected.waitFor((message) => message.id === "logout")).toMatchObject({ success: true });
		const afterLogout = JSON.parse(readFileSync(harness.authPath, "utf-8")) as Record<string, unknown>;
		expect(afterLogout.openai).toBeUndefined();
		await handler.dispose();
	});

	it("refuses a login_api_key without a usable key and stores nothing (#3867)", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		for (const [id, extra] of [
			["missing", {}],
			["empty", { key: "" }],
			["blank", { key: "  " }],
		] as const) {
			await handler.handleInputLine(JSON.stringify({ id, type: "login_api_key", provider: "anthropic", ...extra }));
			expect(await collected.waitFor((message) => message.id === id)).toMatchObject({
				success: false,
				error: expect.stringContaining("empty API key"),
			});
		}
		const stored = JSON.parse(readFileSync(harness.authPath, "utf-8")) as Record<string, unknown>;
		expect(stored.anthropic).toBeUndefined();
		await handler.dispose();
	});

	it("auth_login_end names the API key an OAuth login replaced and where its backup is (senpi#3486)", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		harness.authStorage.registerOAuthProvider("scripted-oauth", {
			name: "Scripted OAuth",
			async login() {
				return {
					type: "oauth",
					access: "scripted-access",
					refresh: "scripted-refresh",
					expires: 4_102_444_800_000,
				};
			},
			async refresh(credentials) {
				return credentials;
			},
			async toAuth(credentials) {
				return { apiKey: credentials.access };
			},
		});
		harness.authStorage.set("scripted-oauth", { type: "api_key", key: "sk-FAKE-previous" });
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		const replacing = collected.waitFor((message) => message.type === "auth_login_end");
		await handler.handleInputLine(JSON.stringify({ id: "replace", type: "login_start", provider: "scripted-oauth" }));
		const end = await replacing;
		expect(end).toMatchObject({
			provider: "scripted-oauth",
			success: true,
			replaced: "api_key",
			backupPath: expect.any(String),
		});
		const backupPath = String(end.backupPath);
		expect(readFileSync(backupPath, "utf-8")).toContain("sk-FAKE-previous");
		expect(harness.authStorage.takeReplacement("scripted-oauth")).toBeUndefined();

		const sameKind = collected.waitFor((message) => message.type === "auth_login_end" && message !== end);
		await handler.handleInputLine(JSON.stringify({ id: "again", type: "login_start", provider: "scripted-oauth" }));
		const second = await sameKind;
		expect(second).toMatchObject({ provider: "scripted-oauth", success: true });
		expect(second).not.toHaveProperty("replaced");
		expect(second).not.toHaveProperty("backupPath");
		await handler.dispose();
	});

	it("writes response records only to the injected sink", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const stdoutSpy = vi.spyOn(process.stdout, "write");
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(JSON.stringify({ id: "state", type: "get_state" }));

		expect(await collected.waitFor((message) => message.id === "state")).toMatchObject({
			type: "response",
			command: "get_state",
			success: true,
		});
		expect(stdoutSpy).not.toHaveBeenCalled();
		stdoutSpy.mockRestore();
		await handler.dispose();
	});

	it("installs no process signal handlers and frames unknown commands as errors", async () => {
		const before = process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP");
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(JSON.stringify({ id: "unknown", type: "no_such_command" }));

		expect(process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP")).toBe(before);
		expect(await collected.waitFor((message) => message.id === "unknown")).toMatchObject({
			success: false,
			error: expect.stringContaining("Unknown command"),
		});
		await handler.dispose();
	});

	it("emits an optional custom-UI capability notice without changing default clients", async () => {
		const factory = (() => ({ render: () => "" })) as never;
		const flagged = makeSink();
		const flaggedHarness = makeHarness(tempDir);
		cleanup = flaggedHarness.cleanup;
		const flaggedHandler = createRpcConnectionHandler(flaggedHarness.runtimeHost, flagged.sink, {
			capabilities: ["custom_unsupported"],
		});
		await flaggedHandler.ready;
		const notice = flagged.waitFor(
			(message) => message.type === "extension_ui_request" && message.method === "custom_unsupported",
		);

		expect(await flaggedHarness.runtimeHost.session.extensionRunner.getUIContext().custom(factory)).toBeUndefined();
		expect(await notice).toMatchObject({ method: "custom_unsupported", extensionName: expect.any(String) });
		await flaggedHandler.dispose();
		flaggedHarness.cleanup();

		const plain = makeSink();
		const plainHarness = makeHarness(tempDir);
		cleanup = plainHarness.cleanup;
		const plainHandler = createRpcConnectionHandler(plainHarness.runtimeHost, plain.sink);
		await plainHandler.ready;

		expect(await plainHarness.runtimeHost.session.extensionRunner.getUIContext().custom(factory)).toBeUndefined();
		expect(
			plain
				.messages()
				.find((message) => message.type === "extension_ui_request" && message.method === "custom_unsupported"),
		).toBeUndefined();
		await plainHandler.dispose();
	});
});

const FUTURE = 4_102_444_800_000;
const modelBlocks = { limited: { blockedUntil: FUTURE } };
const block = { blockReason: "account_disabled" as const, blockedUntil: FUTURE };
const history = { failureCount: 3, lastSuccessAt: 1, modelBlocks, lease: { id: "probe", expiresAt: FUTURE } };

// Desktop #4203 U1: the public RPC must perform the same full reset as the CLI.
// The direct #3285 owner cannot catch dispatch, early acknowledgements or leaked storage errors.
// These tests exercise the real handler and stores without a production-only test seam.
describe("account_reset unblocks one account over RPC", () => {
	let dir: string;
	let harness: ReturnType<typeof makeHarness>;
	let collected: ReturnType<typeof makeSink>;
	let handler: ReturnType<typeof createRpcConnectionHandler>;
	let envBefore: NodeJS.ProcessEnv;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rpc-account-reset-4203-"));
		envBefore = {
			OPENAI_API_KEY: process.env.OPENAI_API_KEY,
			OPENAI_API_KEY_2: process.env.OPENAI_API_KEY_2,
		};
		harness = makeHarness(dir);
		collected = makeSink();
		handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
	});

	afterEach(async () => {
		await handler.dispose();
		harness.cleanup();
		for (const key of ["OPENAI_API_KEY", "OPENAI_API_KEY_2"]) {
			if (envBefore[key] === undefined) delete process.env[key];
			else process.env[key] = envBefore[key];
		}
		rmSync(dir, { recursive: true, force: true });
	});

	async function send(id: string, command: Record<string, unknown>) {
		const response = collected.waitFor((message) => message.id === id, 5_000);
		await handler.handleInputLine(JSON.stringify({ id, ...command }));
		return response;
	}

	async function seed(provider: string) {
		const oauth = provider === "anthropic-subscription";
		const accounts = ["a", "b"].map((name) => ({
			name,
			...(oauth
				? { access: `access-${name}`, refresh: `refresh-${name}`, expires: FUTURE }
				: { key: `synthetic-${name}` }),
			source: name === "a" ? ("import" as const) : ("login" as const),
			displayName: `Account ${name}`,
			...block,
			modelBlocks,
			authRecoveryGrant: "kept",
		}));
		await harness.authStorage.modify(provider, async () => ({
			...(oauth
				? { type: "oauth" as const, ...SENTINEL_OAUTH_FIELDS }
				: { type: "api_key" as const, key: "synthetic-a" }),
			accounts,
			pinned: "b",
			order: ["b", "a"],
			slotState: { a: { ...block, modelBlocks }, b: { ...block, modelBlocks } },
		}));
		const repo = credentialPoolRepository(harness.authStorage);
		for (const slot of accounts) {
			const credentialRevision = await repo.storedCredentialRevision(provider, slot.name, slot);
			await repo.mutateSlotState(provider, "stored", slot.name, () => ({
				...block,
				...history,
				credentialRevision,
			}));
		}
		return repo;
	}

	for (const provider of ["openai", "anthropic-subscription"]) {
		it(`resets all named-account health and preserves credentials, pins and order for ${provider}`, async () => {
			const repo = await seed(provider);
			const authBefore = JSON.parse(readFileSync(harness.authPath, "utf8"));
			const sidecarBefore = await repo.listSlots(provider, "stored");
			expect(await send("before", { type: "get_provider_accounts", provider })).toMatchObject({
				data: {
					accounts: [
						{ name: "b", blocked: true },
						{ name: "a", blocked: true },
					],
				},
			});
			const changed = collected.waitFor(
				(message) => message.type === "auth_accounts_changed" && message.provider === provider,
				5_000,
			);
			// Attach rejection handling before triggering too, so a RED failure leaves no rejected waiter.
			const event = changed.then(
				(value) => value,
				(error: unknown) => error,
			);
			const response = await send("reset", { type: "account_reset", provider, name: "b" });
			expect(response).toEqual({ id: "reset", type: "response", command: "account_reset", success: true });
			expect(await event).toEqual({ type: "auth_accounts_changed", provider });
			expect(await send("after", { type: "get_provider_accounts", provider })).toMatchObject({
				data: {
					ordered: true,
					accounts: [
						{ name: "b", pinned: true, blocked: false },
						{ name: "a", pinned: false, blocked: true },
					],
				},
			});
			const expectedAuth = structuredClone(authBefore);
			delete expectedAuth[provider].accounts[1].blockReason;
			delete expectedAuth[provider].accounts[1].blockedUntil;
			delete expectedAuth[provider].accounts[1].modelBlocks;
			delete expectedAuth[provider].slotState.b;
			expect(JSON.parse(readFileSync(harness.authPath, "utf8"))).toEqual(expectedAuth);
			expect(await repo.listSlots(provider, "stored")).toEqual({
				a: sidecarBefore.a,
			});
			expect(JSON.stringify(collected.messages())).not.toMatch(/synthetic-|access-|refresh-/);
		});
	}

	it("unblocks an environment slot without changing its value or the other slot", async () => {
		process.env.OPENAI_API_KEY = "synthetic-env";
		process.env.OPENAI_API_KEY_2 = "synthetic-env-2";
		const repo = credentialPoolRepository(harness.authStorage);
		for (const [name, variable, value] of [
			["env", "OPENAI_API_KEY", "synthetic-env"],
			["env-2", "OPENAI_API_KEY_2", "synthetic-env-2"],
		]) {
			const credentialRevision = await repo.envCredentialRevision(variable, value);
			await repo.mutateSlotState("openai", "env", name, () => ({ ...block, ...history, credentialRevision }));
		}
		const before = await repo.listSlots("openai", "env");
		const changed = collected.waitFor((message) => message.type === "auth_accounts_changed", 5_000);
		const event = changed.then(
			(value) => value,
			(error: unknown) => error,
		);
		expect(await send("env-reset", { type: "account_reset", provider: "openai", name: "env-2" })).toMatchObject({
			success: true,
		});
		expect(await event).toEqual({ type: "auth_accounts_changed", provider: "openai" });
		expect(await send("env-list", { type: "get_provider_accounts", provider: "openai" })).toMatchObject({
			data: {
				accounts: [
					{ name: "env", blocked: true },
					{ name: "env-2", blocked: false },
				],
			},
		});
		expect(await repo.listSlots("openai", "env")).toEqual({ env: before.env });
		expect(process.env.OPENAI_API_KEY_2).toBe("synthetic-env-2");
		expect(harness.authStorage.get("openai")).toBeUndefined();
	});

	it("returns a correlated typed error for an unknown name without mutation or notice", async () => {
		const repo = await seed("openai");
		const before = readFileSync(harness.authPath, "utf8");
		const state = await repo.listSlots("openai", "stored");
		expect(
			await send("missing", { type: "account_reset", provider: "openai", name: "synthetic-secret-name" }),
		).toMatchObject({
			id: "missing",
			type: "response",
			command: "account_reset",
			success: false,
			errorCode: "account_not_found",
			error: "Provider account not found. Refresh the account list.",
		});
		expect(readFileSync(harness.authPath, "utf8")).toBe(before);
		expect(await repo.listSlots("openai", "stored")).toEqual(state);
		expect(collected.messages().filter((message) => message.type === "auth_accounts_changed")).toEqual([]);
	});

	it.each([
		{ provider: null, name: "b" },
		{ provider: 1, name: "b" },
		{ name: "b" },
		{ provider: "openai", name: null },
		{ provider: "openai", name: 1 },
		{ provider: "openai" },
	])("refuses malformed selectors without changing account state: %j", async (selector) => {
		const repo = await seed("openai");
		const before = readFileSync(harness.authPath, "utf8");
		const state = await repo.listSlots("openai", "stored");
		expect(await send("invalid", { type: "account_reset", ...selector })).toMatchObject({
			id: "invalid",
			command: "account_reset",
			success: false,
			errorCode: "invalid_argument",
		});
		expect(readFileSync(harness.authPath, "utf8")).toBe(before);
		expect(await repo.listSlots("openai", "stored")).toEqual(state);
		expect(collected.messages().filter((message) => message.type === "auth_accounts_changed")).toEqual([]);
	});

	it("acknowledges and publishes only after the stored block write settles", async () => {
		await seed("openai");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const modify = harness.authStorage.modify.bind(harness.authStorage);
		harness.authStorage.modify = async (provider, fn) => {
			entered.resolve();
			await release.promise;
			return modify(provider, fn);
		};
		const changed = collected.waitFor((message) => message.type === "auth_accounts_changed", 5_000);
		const event = changed.then(
			(value) => value,
			(error: unknown) => error,
		);
		const response = send("settled", { type: "account_reset", provider: "openai", name: "b" });
		try {
			await Promise.race([
				entered.promise,
				response.then(() => {
					throw new Error("Response before write");
				}),
			]);
			expect(
				collected
					.messages()
					.some((message) => message.id === "settled" || message.type === "auth_accounts_changed"),
			).toBe(false);
		} finally {
			release.resolve();
		}
		expect(await response).toMatchObject({ success: true });
		expect(await event).toEqual({ type: "auth_accounts_changed", provider: "openai" });
	});

	it("returns failure without a success notice when a stored write rejects", async () => {
		await seed("openai");
		harness.authStorage.modify = async () => {
			throw new Error("Storage failed for synthetic-secret-credential");
		};
		expect(await send("failed", { type: "account_reset", provider: "openai", name: "b" })).toMatchObject({
			id: "failed",
			command: "account_reset",
			success: false,
			error: "Could not reset this account. Try again.",
			errorCode: "account_reset_failed",
		});
		expect(collected.messages().filter((message) => message.type === "auth_accounts_changed")).toEqual([]);
	});
});

// Desktop #4203: the typed client must await the actual engine acknowledgement,
// including turning a failed response into a typed rejection rather than resolving.
it.each([false, true])("round-trips account metadata and reset responses with legacy host=%s", async (legacy) => {
	const dir = mkdtempSync(join(tmpdir(), "reset-client-4203-"));
	const harness = makeHarness(dir);
	const handlers: ReturnType<typeof createRpcConnectionHandler>[] = [];
	const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\reset-${randomUUID()}` : join(dir, "rpc.sock");
	const server = createServer((socket) => {
		const handler = createRpcConnectionHandler(harness.runtimeHost, socketSink(socket));
		handlers.push(handler);
		attachJsonlLineReader(socket, (line) => {
			const command = JSON.parse(line) as { id?: string; type: string };
			if (legacy && (command.type === "account_reset" || command.type === "get_provider_accounts")) {
				socket.write(
					serializeJsonLine({
						type: "response",
						id: command.id,
						command: command.type,
						...(command.type === "account_reset"
							? { success: false, error: "Unknown command: account_reset" }
							: {
									success: true,
									data: { accounts: [{ name: "work", source: "login", blocked: true, pinned: false }] },
								}),
					}),
				);
				return;
			}
			void handler.handleInputLine(line);
		});
	});
	const client = new RpcClient({ socketPath });
	let unsubscribe = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await harness.authStorage.modify("openai", async () => ({
			type: "api_key",
			key: "synthetic",
			accounts: [
				{
					name: "work",
					key: "synthetic",
					blockReason: "account_disabled",
				},
			],
		}));
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		await client.start();
		if (legacy) {
			expect(await client.getProviderAccounts("openai")).toEqual([
				{ name: "work", source: "login", blocked: true, pinned: false },
			]);
			const refused = client.resetProviderAccount("openai", "work");
			await expect(refused).rejects.toBeInstanceOf(RpcCommandError);
			await expect(refused).rejects.toMatchObject({ message: "Unknown command: account_reset" });
			return;
		}
		const changed = new Promise<unknown>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error("No account-change event")), 5_000);
			unsubscribe = client.onEvent((event) => {
				if (event.type !== "auth_accounts_changed") return;
				clearTimeout(timer);
				resolve(event);
			});
		});

		const observed = changed.then(
			(value) => value,
			(error: unknown) => error,
		);

		await client.resetProviderAccount("openai", "work");

		expect(await observed).toMatchObject({ type: "auth_accounts_changed", provider: "openai" });
		expect(await client.getProviderAccounts("openai")).toMatchObject([{ name: "work", blocked: false }]);
		const refused = client.resetProviderAccount("openai", "missing");
		await expect(refused).rejects.toBeInstanceOf(RpcCommandError);
		await expect(refused).rejects.toMatchObject({ errorCode: "account_not_found" });
	} finally {
		clearTimeout(timer);
		unsubscribe();
		await client.stop();
		for (const handler of handlers) await handler.dispose();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});
