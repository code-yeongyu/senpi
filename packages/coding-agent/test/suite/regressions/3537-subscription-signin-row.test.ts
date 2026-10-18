import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.ts";
import { authMethodStatus, buildLoginProviderInfos } from "../../../src/core/auth-providers.ts";
import type { ModelRegistry } from "../../../src/core/model-registry.ts";
import type { ModelRuntime } from "../../../src/core/model-runtime.ts";
import type { AuthStatus } from "../../../src/core/provider-composer.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

/**
 * senpi#3537: a Claude subscription supplied by CLAUDE_CODE_OAUTH_TOKEN or an ambient Claude Code
 * login is a sign-in, so it belongs on the sign-in row; a key (runtime --api-key, env key,
 * models.json) belongs on the key row only, on every /login surface. Each scenario is read from
 * both real surfaces: the RPC rows exactly as `get_auth_providers` builds them, and the TUI
 * picker's `getLoginProviderOptions`.
 */
describe("a credential lands on the row of its kind on every /login surface (senpi#3537)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	interface Fixture {
		readonly auth?: Record<string, unknown>;
		readonly modelsJson?: Record<string, unknown>;
		readonly runtimeKeys?: Readonly<Record<string, string>>;
	}

	type Rows = Partial<Record<"oauth" | "api_key", AuthStatus>>;
	type TuiRows = Partial<Record<"oauth" | "api_key", { type: "oauth" | "api_key"; source?: string } | undefined>>;

	function scratch(): string {
		const root = mkdtempSync(join(tmpdir(), "senpi-3537-"));
		dirs.push(root);
		return root;
	}

	async function services(fixture: Fixture) {
		const root = scratch();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		if (fixture.auth) writeFileSync(join(agentDir, "auth.json"), JSON.stringify(fixture.auth), { mode: 0o600 });
		if (fixture.modelsJson) writeFileSync(join(agentDir, "models.json"), JSON.stringify(fixture.modelsJson));
		const created = await createAgentSessionServices({ cwd, agentDir });
		for (const [id, key] of Object.entries(fixture.runtimeKeys ?? {})) {
			await created.modelRuntime.setRuntimeApiKey(id, key);
		}
		return created;
	}

	function rpcRows(modelRegistry: ModelRegistry, provider: string): Rows {
		const infos = [
			...buildLoginProviderInfos(modelRegistry, "oauth"),
			...buildLoginProviderInfos(modelRegistry, "api_key"),
		].filter((info) => info.id === provider);
		return Object.fromEntries(infos.map((info) => [info.authType, authMethodStatus(modelRegistry, info)]));
	}

	function tuiRows(modelRuntime: ModelRuntime, modelRegistry: ModelRegistry, provider: string): TuiRows {
		const picker = (
			InteractiveMode as unknown as {
				prototype: {
					getLoginProviderOptions(this: object): Array<{
						id: string;
						authType: "oauth" | "api_key";
						status?: { type: "oauth" | "api_key"; source?: string };
					}>;
				};
			}
		).prototype.getLoginProviderOptions;
		const options = picker.call({ session: { modelRuntime, modelRegistry } }).filter((row) => row.id === provider);
		return Object.fromEntries(options.map((row) => [row.authType, row.status]));
	}

	async function surfaces(provider: string, fixture: Fixture = {}) {
		const { modelRegistry, modelRuntime } = await services(fixture);
		const rpc = rpcRows(modelRegistry, provider);
		const tui = tuiRows(modelRuntime, modelRegistry, provider);
		for (const authType of ["oauth", "api_key"] as const) {
			const rpcRow = rpc[authType];
			if (!rpcRow || !(authType in tui)) continue;
			expect(tui[authType]?.type === authType, `${provider} ${authType}: TUI and RPC agree`).toBe(rpcRow.configured);
		}
		return { rpc, tui };
	}

	function loggedInClaude(): string {
		const executable = join(scratch(), "claude");
		writeFileSync(executable, "#!/bin/sh\nexit 0\n");
		chmodSync(executable, 0o755);
		return executable;
	}

	const TOKEN = "sk-ant-oat01-scripted-not-a-token";
	const SUBSCRIPTION_SIGN_IN = { configured: true, source: "environment", label: "Anthropic Subscription" };

	it("env CLAUDE_CODE_OAUTH_TOKEN: the subscription's sign-in row, not its key row", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
		const { rpc, tui } = await surfaces("anthropic-subscription");
		expect(rpc).toEqual({ oauth: SUBSCRIPTION_SIGN_IN, api_key: { configured: false } });
		expect(tui.oauth?.type).toBe("oauth");
	});

	it.skipIf(process.platform === "win32")("ambient Claude Code login (opted in): the sign-in row", async () => {
		vi.stubEnv("SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION", "ambient");
		vi.stubEnv("SENPI_CLAUDE_SDK_OAUTH_ENABLED", "true");
		vi.stubEnv("CLAUDE_CODE_EXECUTABLE", loggedInClaude());
		const { rpc, tui } = await surfaces("anthropic-subscription");
		expect(rpc).toEqual({ oauth: SUBSCRIPTION_SIGN_IN, api_key: { configured: false } });
		expect(tui.oauth?.type).toBe("oauth");
	});

	it("a runtime --api-key beside an env sign-in: the key row, never the sign-in row", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
		const { rpc, tui } = await surfaces("anthropic-subscription", {
			runtimeKeys: { "anthropic-subscription": "sk-scripted-runtime-key" },
		});
		expect(rpc).toEqual({ oauth: { configured: false }, api_key: { configured: true, source: "runtime" } });
		expect(tui.oauth).toEqual({ type: "api_key", source: "runtime" });
	});

	it("a runtime --api-key on a provider whose sign-in row is its only listed row stays off that row", async () => {
		const { rpc, tui } = await surfaces("chatgpt-subscription", {
			runtimeKeys: { "chatgpt-subscription": "sk-scripted-runtime-key" },
		});
		expect(rpc.oauth).toEqual({ configured: false });
		expect(tui.oauth?.type).toBe("api_key");
	});

	it("a stored subscription beside a runtime --api-key: each keeps its own row", async () => {
		const { rpc, tui } = await surfaces("openrouter", {
			auth: { openrouter: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 } },
			runtimeKeys: { openrouter: "sk-scripted-runtime-key" },
		});
		expect(rpc).toEqual({
			oauth: { configured: true, source: "stored" },
			api_key: { configured: true, source: "runtime" },
		});
		expect(tui).toEqual({
			oauth: { type: "oauth", source: "stored" },
			api_key: { type: "api_key", source: "runtime" },
		});
	});

	it("a stored key outranks an env sign-in and keeps its own row", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
		const { rpc } = await surfaces("anthropic-subscription", {
			auth: { "anthropic-subscription": { type: "api_key", key: "sk-scripted-stored" } },
		});
		expect(rpc).toEqual({ oauth: { configured: false }, api_key: { configured: true, source: "stored" } });
	});

	it("a models.json key outranks the sign-in check and stays on the key row", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
		vi.stubEnv("SCRIPTED_SUBSCRIPTION_KEY", "sk-scripted-not-a-key");
		const { rpc, tui } = await surfaces("anthropic-subscription", {
			modelsJson: { providers: { "anthropic-subscription": { apiKey: "$SCRIPTED_SUBSCRIPTION_KEY" } } },
		});
		expect(rpc).toEqual({
			oauth: { configured: false },
			api_key: { configured: true, source: "environment", label: "SCRIPTED_SUBSCRIPTION_KEY" },
		});
		expect(tui.oauth).toEqual({ type: "api_key", source: "SCRIPTED_SUBSCRIPTION_KEY" });
	});

	it("ANTHROPIC_API_KEY stays a key on anthropic and does not light the subscription", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-scripted-not-a-key");
		const anthropic = await surfaces("anthropic");
		expect(anthropic.rpc.api_key).toEqual({ configured: true, source: "environment", label: "ANTHROPIC_API_KEY" });
		if ("oauth" in anthropic.rpc) expect(anthropic.rpc.oauth).toEqual({ configured: false });
		const subscription = await surfaces("anthropic-subscription");
		expect(subscription.rpc).toEqual({ oauth: { configured: false }, api_key: { configured: false } });
	});

	it("ANTHROPIC_API_KEY beside a subscription token: each on its own provider's row", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-scripted-not-a-key");
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
		expect((await surfaces("anthropic")).rpc.api_key).toEqual({
			configured: true,
			source: "environment",
			label: "ANTHROPIC_API_KEY",
		});
		expect((await surfaces("anthropic-subscription")).rpc).toEqual({
			oauth: SUBSCRIPTION_SIGN_IN,
			api_key: { configured: false },
		});
	});

	it("no credential: both subscription rows unconfigured on both surfaces", async () => {
		const { rpc, tui } = await surfaces("anthropic-subscription");
		expect(rpc).toEqual({ oauth: { configured: false }, api_key: { configured: false } });
		expect(tui.oauth).toBeUndefined();
	});

	it("keeps an environment API key on the provider's key row", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-scripted-not-a-key");
		const { rpc } = await surfaces("openai");
		expect(rpc.api_key).toEqual({ configured: true, source: "environment", label: "OPENAI_API_KEY" });
		if ("oauth" in rpc) expect(rpc.oauth).toEqual({ configured: false });
	});
});
