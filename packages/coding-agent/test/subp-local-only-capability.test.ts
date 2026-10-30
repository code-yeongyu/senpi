import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
	registerAnthropicSubscriptionExtension,
} from "../src/core/extensions/builtin/anthropic-subscription/index.ts";
import {
	CURSOR_CLI_OAUTH_PROVIDER_ID,
	registerCursorCliOauthExtension,
} from "../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import { CursorAgentNotInstalledError } from "../src/core/extensions/builtin/cursor-cli-oauth/executable.ts";
import type { CursorCliOauthProviderSettings } from "../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import {
	registerVertexModelGarden,
	VERTEX_MODEL_GARDEN_PROVIDER_ID,
} from "../src/core/extensions/builtin/vertex-model-garden/index.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { findInitialModel, resolveCliModel, resolveModelScopeWithDiagnostics } from "../src/core/model-resolver.ts";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";
import { createRuntime, type ModelsJsonFile, modelsJsonFile } from "./support/baseurl-override-fixture.ts";

/**
 * SUBP-LOCAL.a: builtin providers whose requests run through a local subprocess under a login held on
 * this machine carry the inert `localOnly` capability. SUBP-LOCAL.c: nothing reads it yet, so one-machine
 * provider selection and model resolution are byte-identical with and without the flag.
 */

const directories: string[] = [];
let models: ModelsJsonFile | undefined;

afterEach(() => {
	models?.remove();
	models = undefined;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "subp-local-only-"));
	directories.push(directory);
	return directory;
}

function recordingApi(cwd: string, registrations: Map<string, ProviderConfigInput>): ExtensionAPI {
	return new Proxy(
		{
			cwd,
			registerProvider: (name: string, config: ProviderConfigInput) => {
				registrations.set(name, config);
			},
		},
		{ get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined) },
	) as unknown as ExtensionAPI;
}

function cursorSettings(): CursorCliOauthProviderSettings {
	return {
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
	};
}

function builtinProviderRegistrations(): Map<string, ProviderConfigInput> {
	const registrations = new Map<string, ProviderConfigInput>();
	const cwd = temporaryDirectory();
	const pi = recordingApi(cwd, registrations);
	registerAnthropicSubscriptionExtension(pi, {
		readSettings: () => ({ enabled: true }),
		readAmbientAuthStatus: async () => true,
	});
	registerCursorCliOauthExtension(pi, {
		cwd,
		agentDir: temporaryDirectory(),
		store: new InMemoryCredentialStore(),
		readCurrent: async () => undefined,
		loadSettings: () => cursorSettings(),
		resolveExecutable: () => {
			throw new CursorAgentNotInstalledError();
		},
	});
	registerVertexModelGarden(pi);
	return registrations;
}

function withoutLocalOnly(config: ProviderConfigInput): ProviderConfigInput {
	const copy: ProviderConfigInput = { ...config };
	delete copy.localOnly;
	return copy;
}

async function resolutionSnapshot(registrations: Map<string, ProviderConfigInput>): Promise<string> {
	models = modelsJsonFile({});
	const runtime = await createRuntime(models.path);
	for (const [name, config] of registrations) await runtime.registerProvider(name, config);
	const firstOf = (provider: string): string => {
		const model = runtime.getModels().find((entry) => entry.provider === provider);
		if (!model) throw new Error(`no model registered for ${provider}`);
		return model.id;
	};
	const subscriptionModel = firstOf(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
	const cursorModel = firstOf(CURSOR_CLI_OAUTH_PROVIDER_ID);
	const providers = [...registrations.keys()];
	const snapshot = {
		models: runtime.getModels(),
		available: await runtime.getAvailable(),
		fallbackEligible: providers.map((provider) => [provider, runtime.isFallbackEligible(provider)]),
		cli: [
			`${ANTHROPIC_SUBSCRIPTION_PROVIDER_ID}/${subscriptionModel}`,
			`${CURSOR_CLI_OAUTH_PROVIDER_ID}/${cursorModel}`,
			subscriptionModel,
			cursorModel,
		].map((cliModel) => resolveCliModel({ cliModel, modelRuntime: runtime })),
		initial: [
			await findInitialModel({
				cliProvider: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
				cliModel: subscriptionModel,
				scopedModels: [],
				isContinuing: false,
				modelRuntime: runtime,
			}),
			await findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
				defaultModelId: subscriptionModel,
				modelRuntime: runtime,
			}),
			await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime }),
		],
		scope: await resolveModelScopeWithDiagnostics(
			providers.map((provider) => `${provider}/*`),
			runtime,
		),
	};
	return JSON.stringify(snapshot);
}

describe("SUBP-LOCAL.a: local-only capability on builtin providers", () => {
	it("flags exactly the providers that need a local binary and a local login", () => {
		const registrations = builtinProviderRegistrations();
		expect([...registrations.keys()].sort()).toEqual(
			[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, CURSOR_CLI_OAUTH_PROVIDER_ID, VERTEX_MODEL_GARDEN_PROVIDER_ID].sort(),
		);
		const flags = Object.fromEntries([...registrations].map(([name, config]) => [name, config.localOnly]));
		expect(flags).toEqual({
			// Runs Claude Code through @anthropic-ai/claude-agent-sdk as a subprocess, under Claude logins on this machine.
			[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID]: true,
			// Runs the cursor-agent CLI as a subprocess, under Cursor logins on this machine.
			[CURSOR_CLI_OAUTH_PROVIDER_ID]: true,
			// Plain HTTPS to Vertex with ADC credentials; no local binary in the request path.
			[VERTEX_MODEL_GARDEN_PROVIDER_ID]: undefined,
		});
	});

	it("keeps the flag in the provider registry", async () => {
		models = modelsJsonFile({});
		const runtime = await createRuntime(models.path);
		for (const [name, config] of builtinProviderRegistrations()) await runtime.registerProvider(name, config);
		expect(runtime.getRegisteredProviderConfig(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID)?.localOnly).toBe(true);
		expect(runtime.getRegisteredProviderConfig(CURSOR_CLI_OAUTH_PROVIDER_ID)?.localOnly).toBe(true);
		expect(runtime.getRegisteredProviderConfig(VERTEX_MODEL_GARDEN_PROVIDER_ID)?.localOnly).toBeUndefined();
	});
});

describe("SUBP-LOCAL.c: one-machine selection and resolution ignore local-only", () => {
	it("resolves byte-identically with and without the flag", async () => {
		const flagged = builtinProviderRegistrations();
		const unflagged = new Map([...flagged].map(([name, config]) => [name, withoutLocalOnly(config)]));
		expect([...unflagged.values()].some((config) => "localOnly" in config)).toBe(false);

		const before = await resolutionSnapshot(unflagged);
		models?.remove();
		const after = await resolutionSnapshot(flagged);

		expect(after).toBe(before);
	});
});
