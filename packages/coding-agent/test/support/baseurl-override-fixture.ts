import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelConfig } from "../../src/core/model-config.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../src/core/models-store.ts";
import type { ProviderChatModelConfig } from "../../src/core/provider-composer.ts";

export const EXTENSION_HOST = "https://extension-host.invalid/v1";

export function chatDefinition(id: string, baseUrl?: string): ProviderChatModelConfig {
	return {
		id,
		name: id,
		...(baseUrl === undefined ? {} : { baseUrl }),
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};
}

export function chatModel(provider: string, id: string, baseUrl: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};
}

export interface ModelsJsonFile {
	readonly path: string;
	write(providers: Record<string, unknown>): void;
	config(): ModelConfig;
	remove(): void;
}

export function modelsJsonFile(providers: Record<string, unknown>): ModelsJsonFile {
	const dir = mkdtempSync(join(tmpdir(), "senpi-4765-models-json-"));
	const path = join(dir, "models.json");
	const write = (next: Record<string, unknown>) => writeFileSync(path, JSON.stringify({ providers: next }));
	write(providers);
	return {
		path,
		write,
		config: () => ModelConfig.loadSync(path),
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export function createRuntime(modelsPath: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
}

export function requireModel(runtime: ModelRuntime, provider: string, id: string): Model<Api> {
	const model = runtime.getModel(provider, id);
	if (model === undefined) throw new Error(`Expected model ${provider}/${id}`);
	return model;
}
