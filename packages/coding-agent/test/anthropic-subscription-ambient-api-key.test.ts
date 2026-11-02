import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { stripAmbientApiKey } from "../src/core/extensions/builtin/anthropic-subscription/auth-environment.ts";
import { probeAmbientClaudeAuthStatus } from "../src/core/extensions/builtin/anthropic-subscription/availability.ts";
import type { AmbientApiKeyIgnoredDiagnostic } from "../src/core/extensions/builtin/anthropic-subscription/guidance.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import type {
	Options,
	SDKMessage,
	SdkQuery,
} from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	type AnthropicSubscriptionAmbientApiKey,
	loadAnthropicSubscriptionProviderSettings,
} from "../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { authContext } from "./support/anthropic-subscription-provider.ts";

const KEY = "host-api-key";
const GATEWAY = "https://gateway.invalid";

type Row = { name: string; env: NodeJS.ProcessEnv; policy: AnthropicSubscriptionAmbientApiKey; keeps: boolean };

const hosts: { name: string; env: NodeJS.ProcessEnv; stripKeeps: boolean }[] = [
	{ name: "x-api-key gateway (BASE_URL, no AUTH_TOKEN)", env: { ANTHROPIC_BASE_URL: GATEWAY }, stripKeeps: true },
	{
		name: "bearer gateway (BASE_URL + AUTH_TOKEN)",
		env: { ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_AUTH_TOKEN: "gateway-token" },
		stripKeeps: false,
	},
	{ name: "direct (neither set)", env: {}, stripKeeps: false },
	{ name: "empty BASE_URL", env: { ANTHROPIC_BASE_URL: "" }, stripKeeps: false },
];

const rows: Row[] = hosts.flatMap((host) => [
	{ name: `${host.name}, strip`, env: host.env, policy: "strip" as const, keeps: host.stripKeeps },
	{ name: `${host.name}, inherit`, env: host.env, policy: "inherit" as const, keeps: true },
]);

function hostEnvironment(row: Row): NodeJS.ProcessEnv {
	return { PATH: "/usr/bin", ANTHROPIC_API_KEY: KEY, SENPI_SEED: "seed", ...row.env };
}

async function probeEnvironment(row: Row): Promise<NodeJS.ProcessEnv> {
	const seen: NodeJS.ProcessEnv[] = [];
	await probeAmbientClaudeAuthStatus({
		env: hostEnvironment(row),
		ambientApiKey: row.policy,
		spawnProbe: (_command, _args, env) => {
			seen.push(env);
			const child = {
				pid: 4242,
				once(event: "error" | "close", listener: (code: number | null) => void) {
					if (event === "close") queueMicrotask(() => listener(0));
					return child;
				},
				kill() {},
			};
			return child;
		},
	});
	expect(seen).toHaveLength(1);
	return seen[0] ?? {};
}

async function turnEnvironment(row: Row): Promise<NodeJS.ProcessEnv> {
	const captured: Options[] = [];
	const query: SdkQuery = (input) => {
		if (input.options) captured.push(input.options);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
	const environment = hostEnvironment(row);
	overrideAuthLaneBoundary({ createStore: () => new InMemoryCredentialStore(), env: () => environment });
	const messages: SDKMessage[] = [];
	for await (const message of queryWithAuthLane({
		prompt: "hi",
		query,
		buildOptions: () => ({}),
		providerSettings: { ambientApiKey: row.policy },
	}))
		messages.push(message);
	expect(messages.length).toBeGreaterThan(0);
	expect(captured).toHaveLength(1);
	return (captured[0]?.env ?? {}) as NodeJS.ProcessEnv;
}

afterEach(() => resetAuthLaneBoundary());

describe("ambient lane host ANTHROPIC_API_KEY (senpi#1195)", () => {
	it.each(rows)("$name: keeps the key = $keeps", (row) => {
		const environment = stripAmbientApiKey(hostEnvironment(row), row.policy);

		expect(environment.ANTHROPIC_API_KEY).toBe(row.keeps ? KEY : undefined);
		expect(environment).not.toHaveProperty("SENPI_SEED");
		expect(environment.PATH).toBe("/usr/bin");
	});

	it.each(rows)("$name: the auth status probe spawns with the same predicate", async (row) => {
		expect(await probeEnvironment(row)).toEqual(stripAmbientApiKey(hostEnvironment(row), row.policy));
	});

	it.each(rows)("$name: the turn lane spawns with the same predicate", async (row) => {
		const expected = stripAmbientApiKey(hostEnvironment(row), row.policy);
		const environment = await turnEnvironment(row);

		expect(environment.ANTHROPIC_API_KEY).toBe(expected.ANTHROPIC_API_KEY);
		expect(environment).not.toHaveProperty("SENPI_SEED");
		expect(environment).toMatchObject(expected);
	});

	it("reads ambientApiKey from settings and lets SENPI_CLAUDE_SDK_OAUTH_AMBIENT_API_KEY override it", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ anthropicSubscriptionProvider: { ambientApiKey: "strip" } }));
		const manager = SettingsManager.fromStorage(storage);

		expect(loadAnthropicSubscriptionProviderSettings(manager, {}).ambientApiKey).toBe("strip");
		expect(
			loadAnthropicSubscriptionProviderSettings(manager, { SENPI_CLAUDE_SDK_OAUTH_AMBIENT_API_KEY: "inherit" })
				.ambientApiKey,
		).toBe("inherit");
		expect(
			loadAnthropicSubscriptionProviderSettings(manager, { SENPI_CLAUDE_SDK_OAUTH_AMBIENT_API_KEY: "bogus" })
				.ambientApiKey,
		).toBe("strip");
	});

	it("reports the ignored key by kind when an API-key-only host leaves the provider unconfigured", async () => {
		const diagnostics: AmbientApiKeyIgnoredDiagnostic[] = [];
		const policies: (AnthropicSubscriptionAmbientApiKey | undefined)[] = [];
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAmbientAuthStatus: async (_signal, policy) => {
				policies.push(policy);
				return false;
			},
			readSettings: () => ({ enabled: true }),
			claudeCli: { env: () => ({ PATH: "/usr/bin", ANTHROPIC_API_KEY: KEY }) },
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});

		expect(await config.check({ ctx: authContext() })).toBeUndefined();
		expect(await config.check({ ctx: authContext() })).toBeUndefined();

		expect(policies).toEqual(["strip", "strip"]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ kind: "ambient_api_key_ignored", ignoredKey: "ANTHROPIC_API_KEY" });
		expect(JSON.stringify(diagnostics[0])).not.toContain(KEY);
	});

	it("reports nothing when the key is kept for an x-api-key gateway", async () => {
		const diagnostics: AmbientApiKeyIgnoredDiagnostic[] = [];
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAmbientAuthStatus: async () => false,
			readSettings: () => ({ enabled: true }),
			claudeCli: { env: () => ({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: GATEWAY }) },
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});

		expect(await config.check({ ctx: authContext() })).toBeUndefined();
		expect(diagnostics).toEqual([]);
	});
});
