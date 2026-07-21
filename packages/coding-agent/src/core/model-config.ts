/** Immutable, credential-blind models.json snapshot. */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { TLocalizedValidationError } from "typebox/error";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import { type ModelsJson, type ModelsJsonProvider, validateModelsConfig } from "./model-config-schema.ts";

export type {
	ModelsJsonModel,
	ModelsJsonModelOverride,
	ModelsJsonProvider,
} from "./model-config-schema.ts";

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** One immutable load of models.json. */
export class ModelConfig {
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	private readonly disabledProviders: ReadonlySet<string>;
	private readonly error: string | undefined;

	private constructor(
		providers: ReadonlyMap<string, ModelsJsonProvider>,
		disabledProviders: ReadonlySet<string> = new Set(),
		error?: string,
	) {
		this.providers = providers;
		this.disabledProviders = disabledProviders;
		this.error = error;
	}

	private static parse(content: string, path: string): ModelConfig {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(content));
		} catch (error) {
			return new ModelConfig(
				new Map(),
				new Set(),
				`Failed to parse models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		if (!validateModelsConfig.Check(parsed)) {
			const errors =
				validateModelsConfig
					.Errors(parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return new ModelConfig(new Map(), new Set(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
		}

		const config = parsed as ModelsJson;
		const providers = new Map<string, ModelsJsonProvider>();
		for (const [providerId, provider] of Object.entries(config.providers)) {
			providers.set(providerId, deepFreeze(structuredClone(provider)));
		}
		return new ModelConfig(providers, new Set(config.disabledProviders ?? []));
	}

	static async load(modelsJsonPath: string | undefined): Promise<ModelConfig> {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		const path = normalizePath(modelsJsonPath);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			return new ModelConfig(
				new Map(),
				new Set(),
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}
		return ModelConfig.parse(content, path);
	}

	static loadSync(modelsJsonPath: string | undefined): ModelConfig {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		const path = normalizePath(modelsJsonPath);
		try {
			return ModelConfig.parse(readFileSync(path, "utf-8"), path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			return new ModelConfig(
				new Map(),
				new Set(),
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.providers.get(providerId);
	}

	getProviderIds(): readonly string[] {
		return [...this.providers.keys()];
	}

	isProviderDisabled(providerId: string): boolean {
		return this.disabledProviders.has(providerId) || this.providers.get(providerId)?.disabled === true;
	}

	getError(): string | undefined {
		return this.error;
	}
}
