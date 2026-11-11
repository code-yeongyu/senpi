// Shared fixture for the CK21 request-hook tests: one fixed provider request, and the fused CLI's own dispatch of it
// (the `onPayload` callback `createAgentSession` hands its Agent, which every provider adapter calls before a dial).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { BeforeProviderRequestEvent, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

export const REQUEST_PAYLOAD = {
	model: "probe-model-upstream",
	max_tokens: 1024,
	stream: true,
	system: [{ type: "text", text: "You are a probe." }],
	messages: [{ role: "user", content: [{ type: "text", text: "hello from the probe" }] }],
	metadata: { user_id: "probe-user" },
};

/** The effective request model. Its `headers` stand in for models.json headers, which may carry a credential. */
export const REQUEST_MODEL: Model<Api> = {
	id: "probe-model",
	name: "Probe Model",
	api: "anthropic-messages",
	provider: "probe-provider",
	baseUrl: "https://probe.invalid/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
	upstreamModelId: "probe-model-upstream",
	headers: { "x-probe-model-header": "model-header-sentinel" },
};

export const REQUEST_HEADERS = { "x-probe-request-header": "request-header-sentinel" };

export interface FusedDispatch {
	readonly seen: BeforeProviderRequestEvent[];
	readonly result: unknown;
}

/**
 * Runs the fixed request through a fused session's own request-hook dispatch with `factory` loaded as a user extension
 * (path `/user/probe-ext.ts`), and returns what the extension saw and what the adapter would send.
 */
export async function fusedDispatch(
	factory: (seen: BeforeProviderRequestEvent[]) => ExtensionFactory,
): Promise<FusedDispatch> {
	const dir = mkdtempSync(join(tmpdir(), "ck21-fused-"));
	const faux = registerFauxProvider();
	const seen: BeforeProviderRequestEvent[] = [];
	try {
		const authStorage = AuthStorage.inMemory();
		const model = faux.getModel();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(dir, "models.json"),
		});
		const extensionsResult = await createTestExtensionsResult(
			[{ path: "/user/probe-ext.ts", factory: factory(seen) }],
			dir,
		);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(dir),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		try {
			const onPayload = session.agent.onPayload;
			if (onPayload === undefined) throw new Error("a fused session hands its Agent no onPayload");
			const result = await onPayload(structuredClone(REQUEST_PAYLOAD), REQUEST_MODEL, {
				model: REQUEST_MODEL,
				headers: { ...REQUEST_HEADERS },
			});
			return { seen, result };
		} finally {
			session.dispose();
		}
	} finally {
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	}
}
