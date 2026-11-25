import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { ModelConfig } from "../core/model-config.ts";
import { discoverProviderModels, type ModelsDiscoveryReport } from "../core/model-discovery.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { resolveHeadersOrThrow } from "../core/resolve-config-value.ts";
import { type EngineOk, type EngineResult, engineError, engineOk, errorMessage } from "./result.ts";

const CATALOG_REFRESH_TIMEOUT_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 30_000;

/** Refreshes every provider's remote model catalog from the network. */
export async function updateModelCatalogs(scope: {
	readonly agentDir: string;
}): Promise<EngineResult<Record<string, never>, "refresh_failed">> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CATALOG_REFRESH_TIMEOUT_MS);
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(scope.agentDir, "auth.json"),
			modelsPath: join(scope.agentDir, "models.json"),
			allowModelNetwork: false,
			signal: controller.signal,
		});
		const result = await modelRuntime.refresh({ allowNetwork: true, force: true, signal: controller.signal });
		if (result.aborted) return engineError("refresh_failed", "Model catalog refresh timed out.");
		if (result.errors.size > 0) {
			const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
			return engineError("refresh_failed", `Could not refresh model catalogs: ${details}`);
		}
		return engineOk({});
	} catch (error: unknown) {
		return engineError("refresh_failed", errorMessage(error, "Unknown model catalog refresh error"));
	} finally {
		clearTimeout(timeout);
	}
}

export interface ModelsDiscoverInput {
	/** A provider defined in models.json; a keyless local server need not be a registered provider. */
	readonly provider: string;
}

/** Lists `<baseUrl>/models` of one OpenAI-compatible provider once and writes the result into models.json. */
export async function discoverModels(
	scope: { readonly agentDir: string },
	input: ModelsDiscoverInput,
): Promise<EngineResult<ModelsDiscoveryReport, "invalid_input" | "discovery_failed">> {
	if (input.provider.length === 0 || input.provider.startsWith("-")) {
		return engineError("invalid_input", "provider must name a provider defined in models.json");
	}
	const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const modelsPath = join(scope.agentDir, "models.json");
	try {
		const config = await ModelConfig.load(modelsPath);
		const configured = await resolveHeadersOrThrow(
			config.getProvider(input.provider)?.headers,
			`provider "${input.provider}"`,
		);
		const runtime = await ModelRuntime.create({
			authPath: join(scope.agentDir, "auth.json"),
			modelsPath,
			allowModelNetwork: false,
			signal,
		});
		const auth = runtime.getProvider(input.provider)
			? (await runtime.getAuth(input.provider, { signal }))?.auth
			: undefined;
		const report = await discoverProviderModels({
			providerId: input.provider,
			modelsPath,
			auth: { apiKey: auth?.apiKey, headers: { ...configured, ...auth?.headers } },
			signal,
		});
		return engineOk(report);
	} catch (error: unknown) {
		return engineError("discovery_failed", error instanceof Error ? error.message : String(error));
	}
}

export interface ModelsListInput {
	/** A fuzzy filter over `<provider> <id>`. */
	readonly pattern?: string;
}

export interface ModelListing {
	/** The models.json load error, when the file could not be read; the listing still answers. */
	readonly loadError?: string;
	/** How many models the runtime has before the pattern is applied. */
	readonly available: number;
	/** The models matching the pattern, by provider then id. */
	readonly models: readonly Model<Api>[];
}

/** The model listing of one runtime: the core the CLI and the exported `models.list` share. */
export function listModelsOf(modelRuntime: ModelRuntime, input: ModelsListInput): EngineOk<ModelListing> {
	const loadError = modelRuntime.getError();
	const all = [...modelRuntime.getModels()];
	const matching = input.pattern ? fuzzyFilter(all, input.pattern, (m) => `${m.provider} ${m.id}`) : all;
	const models = [...matching].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	return engineOk({ ...(loadError ? { loadError } : {}), available: all.length, models });
}
