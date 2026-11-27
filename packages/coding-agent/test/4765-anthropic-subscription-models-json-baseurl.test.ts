import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import {
	ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
	anthropicSubscriptionModels,
	registerAnthropicSubscriptionExtension,
} from "../src/core/extensions/builtin/anthropic-subscription/index.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";
import {
	createRuntime,
	type ModelsJsonFile,
	modelsJsonFile,
	requireModel,
} from "./support/baseurl-override-fixture.ts";
import {
	type FetchGuard,
	installLoopbackFetchGuard,
	type LoopbackServer,
	startLoopbackServer,
} from "./support/loopback-network.ts";

const HOST_GATEWAY = "https://host-gateway.invalid";
const CLAUDE_CODE_DEFAULT_BASE_URL = "https://api.anthropic.com";

function subscriptionRegistration(cwd: string): ProviderConfigInput {
	const registrations: ProviderConfigInput[] = [];
	const pi = new Proxy(
		{
			cwd,
			registerProvider: (_providerId: string, config: ProviderConfigInput) => registrations.push(config),
		},
		{ get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined) },
	) as unknown as ExtensionAPI;
	registerAnthropicSubscriptionExtension(pi, {
		readSettings: () => ({ enabled: true }),
		readAmbientAuthStatus: async () => true,
	});
	const registration = registrations[0];
	if (!registration) throw new Error("anthropic-subscription registered no provider");
	return registration;
}

/**
 * Stands in for the Claude Code subprocess at the SDK spawn boundary: it sends its Messages request where
 * Claude Code does, to `ANTHROPIC_BASE_URL` from the environment the lane hands the subprocess.
 */
function claudeCodeRequesting(spawned: Options[]): SdkQuery {
	return (input) => {
		const options = input.options ?? {};
		spawned.push(options);
		const baseUrl = options.env?.ANTHROPIC_BASE_URL ?? CLAUDE_CODE_DEFAULT_BASE_URL;
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" }).catch(() => undefined);
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
}

let server: LoopbackServer;
let guard: FetchGuard;
let models: ModelsJsonFile | undefined;
let directory: string;

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "senpi-4765-anthropic-subscription-"));
	overrideAuthLaneBoundary({
		createStore: () => new InMemoryCredentialStore(),
		env: () => ({ PATH: process.env.PATH, ANTHROPIC_BASE_URL: HOST_GATEWAY }),
		getAgentDir: () => directory,
	});
	server = await startLoopbackServer();
	guard = installLoopbackFetchGuard();
});

afterEach(async () => {
	resetSdkBoundary();
	resetAuthLaneBoundary();
	models?.remove();
	models = undefined;
	await server.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("senpi#4765 anthropic-subscription honors a models.json baseUrl", () => {
	it("hands Claude Code the models.json baseUrl, so its request reaches that URL instead of the host's", async () => {
		const userBaseUrl = new URL(server.url).origin;
		models = modelsJsonFile({ [ANTHROPIC_SUBSCRIPTION_PROVIDER_ID]: { baseUrl: userBaseUrl } });
		const runtime = await createRuntime(models.path);
		await runtime.registerProvider(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, subscriptionRegistration(directory), {
			refresh: false,
		});
		const spawned: Options[] = [];
		overrideSdkBoundary({ query: claudeCodeRequesting(spawned) });
		const modelId = anthropicSubscriptionModels()[0]?.id ?? "";

		const reply = await runtime.completeSimple(
			requireModel(runtime, ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, modelId),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ cwd: directory },
		);

		expect(reply.errorMessage).toBeUndefined();
		expect(spawned.map((options) => options.env?.ANTHROPIC_BASE_URL)).toEqual([userBaseUrl]);
		expect(guard.blocked).toEqual([]);
		expect(server.requests).toEqual(["/v1/messages"]);
	});
});
