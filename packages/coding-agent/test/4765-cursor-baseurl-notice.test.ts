import { tmpdir } from "node:os";
import type { Context } from "@earendil-works/pi-ai";
import { registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCredential } from "../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	CURSOR_CLI_OAUTH_PROVIDER_ID,
	registerCursorCliOauthExtension,
} from "../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import { STATIC_CURSOR_CLI_MODELS } from "../src/core/extensions/builtin/cursor-cli-oauth/models.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
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

const { cursorTransportCalls, CURSOR_TRANSPORT_CAPTURED } = vi.hoisted(() => ({
	cursorTransportCalls: [] as string[],
	CURSOR_TRANSPORT_CAPTURED: "cursor-agent transport captured the turn",
}));

vi.mock("../src/core/extensions/builtin/cursor-cli-oauth/stream.ts", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		streamCursorCliOauth: (model: { baseUrl: string }) => {
			cursorTransportCalls.push(model.baseUrl);
			throw new Error(CURSOR_TRANSPORT_CAPTURED);
		},
	};
});

const firstCursorModel = STATIC_CURSOR_CLI_MODELS[0];
if (firstCursorModel === undefined) throw new Error("cursor-cli-oauth ships no static models");
const CURSOR_MODEL_ID = firstCursorModel.id;

const userContext: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

let server: LoopbackServer;
let guard: FetchGuard;
let models: ModelsJsonFile | undefined;

beforeAll(() => {
	registerBuiltInApiProviders();
});

beforeEach(async () => {
	cursorTransportCalls.length = 0;
	server = await startLoopbackServer();
	guard = installLoopbackFetchGuard();
});

afterEach(async () => {
	vi.unstubAllGlobals();
	models?.remove();
	models = undefined;
	await server.close();
});

const cursorAccount = () => ({
	...emptyCredential(),
	accounts: [
		{ name: "default", access: "access", refresh: "refresh", expires: Date.now() + 60_000, source: "login" as const },
	],
});

const cursorNotices = (warnings: readonly string[]): string[] =>
	warnings.filter((warning) => warning.includes(CURSOR_CLI_OAUTH_PROVIDER_ID));

async function registerCursorLane(runtime: ModelRuntime, store: AuthStorage): Promise<void> {
	const pending: Promise<unknown>[] = [];
	const pi = {
		registerProvider: (name: string, config: ProviderConfigInput) => {
			pending.push(runtime.registerProvider(name, config, { refresh: false }));
		},
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		on: () => {},
	} as unknown as ExtensionAPI;
	registerCursorCliOauthExtension(pi, {
		cwd: tmpdir(),
		agentDir: tmpdir(),
		store,
		readCurrent: async () => store.read(CURSOR_CLI_OAUTH_PROVIDER_ID),
		runModelsProbe: async () => {
			throw new Error("no cursor-agent model probe in this test");
		},
		loadSettings: () => ({
			enabled: true,
			explicitlyDisabled: false,
			executablePath: undefined,
			forceExecution: true,
			noApprovalAcknowledgedAt: undefined,
			executionMode: "agent",
			resumeMode: "auto",
			pinnedAccount: undefined,
			contextRecapOnModelSwitch: true,
			modelCatalogTtlHours: 24,
			sandboxMode: undefined,
		}),
		resolveExecutable: () => "/qa/cursor-agent",
	});
	await Promise.all(pending);
}

describe("senpi#4765 cursor-cli-oauth cannot change its address", () => {
	it("shows one notice when models.json sets a provider baseUrl for cursor-cli-oauth", async () => {
		models = modelsJsonFile({ [CURSOR_CLI_OAUTH_PROVIDER_ID]: { baseUrl: server.url } });

		expect(cursorNotices(models.config().getWarnings())).toHaveLength(1);
		const runtime = await createRuntime(models.path);
		expect(cursorNotices(runtime.getWarnings())).toHaveLength(1);
	});

	it("shows one notice for a per-model baseUrl, also when the provider baseUrl is set too", () => {
		const modelId = CURSOR_MODEL_ID;
		models = modelsJsonFile({ [CURSOR_CLI_OAUTH_PROVIDER_ID]: { models: [{ id: modelId, baseUrl: server.url }] } });
		expect(cursorNotices(models.config().getWarnings())).toHaveLength(1);

		models.write({
			[CURSOR_CLI_OAUTH_PROVIDER_ID]: { baseUrl: server.url, models: [{ id: modelId, baseUrl: server.url }] },
		});
		expect(cursorNotices(models.config().getWarnings())).toHaveLength(1);
	});

	it("shows no notice when models.json sets no baseUrl for cursor-cli-oauth", async () => {
		models = modelsJsonFile({
			[CURSOR_CLI_OAUTH_PROVIDER_ID]: { modelOverrides: { [CURSOR_MODEL_ID]: { name: "renamed" } } },
			deepseek: { baseUrl: server.url },
		});

		expect(models.config().getWarnings()).toEqual([]);
		const runtime = await createRuntime(models.path);
		expect(runtime.getWarnings()).toEqual([]);
	});

	it("still sends the turn through the Cursor CLI transport, never to the models.json baseUrl", async () => {
		models = modelsJsonFile({ [CURSOR_CLI_OAUTH_PROVIDER_ID]: { baseUrl: server.url } });
		const credentials = AuthStorage.inMemory({ [CURSOR_CLI_OAUTH_PROVIDER_ID]: cursorAccount() });
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: models.path,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
		});
		await registerCursorLane(runtime, credentials);

		const model = requireModel(runtime, CURSOR_CLI_OAUTH_PROVIDER_ID, CURSOR_MODEL_ID);
		expect(model.api).toBe(CURSOR_CLI_OAUTH_PROVIDER_ID);
		const reply = await runtime.completeSimple(model, userContext);

		expect(reply.errorMessage).toBe(CURSOR_TRANSPORT_CAPTURED);
		expect(cursorTransportCalls).toHaveLength(1);
		expect(server.requests).toEqual([]);
		expect(guard.blocked).toEqual([]);
	});
});
