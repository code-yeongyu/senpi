import { join } from "node:path";
import type { Api, AuthResult, Model, Provider } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { AuthStorage } from "./auth-storage.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { ModelRuntime as DefaultModelRuntime } from "./model-runtime.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";

export type { ProviderConfigInput } from "./provider-composer.ts";
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
			extraBody?: Record<string, unknown>;
			upstreamModelId?: string;
			serviceTier?: "auto" | "flex" | "priority";
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };
export { clearApiKeyCache } from "./provider-composer.ts";

/**
 * Synchronous compatibility facade exposed to extensions.
 * Coding-agent internals use ModelRuntime directly.
 */
export class ModelRegistry {
	private readonly runtime: ModelRuntime;
	readonly authStorage: AuthStorage;

	constructor(runtime: ModelRuntime, authStorage: AuthStorage = AuthStorage.inMemory()) {
		this.runtime = runtime;
		this.authStorage = authStorage;
	}

	static create(authStorage: AuthStorage, modelsJsonPath: string = join(getAgentDir(), "models.json")): ModelRegistry {
		return new ModelRegistry(
			DefaultModelRuntime.createSync({ credentials: authStorage, modelsPath: modelsJsonPath }),
			authStorage,
		);
	}

	static inMemory(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(
			DefaultModelRuntime.createSync({ credentials: authStorage, modelsPath: null }),
			authStorage,
		);
	}

	get modelRuntime(): ModelRuntime {
		return this.runtime;
	}

	/** Reload models.json asynchronously. Await before making synchronous registry reads. */
	refresh(): Promise<void> {
		return this.runtime.reloadConfig();
	}

	getError(): string | undefined {
		return this.runtime.getError();
	}

	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	getAvailable(): Model<Api>[] {
		if (this.runtime.hasAvailabilitySnapshot()) {
			return [...this.runtime.getAvailableSnapshot()];
		}
		return this.runtime.getProviders().flatMap((provider) => {
			if (!this.authStorage.hasAuth(provider.id) && !this.runtime.getProviderAuthStatus(provider.id).configured) {
				return [];
			}
			const models = this.runtime.getModels(provider.id);
			return [...(provider.filterModels?.(models, this.authStorage.get(provider.id)) ?? models)];
		});
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.authStorage.hasAuth(model.provider) || this.runtime.getProviderAuthStatus(model.provider).configured;
	}

	getUpstreamModelId(model: Model<Api>): string | undefined {
		return this.runtime.getCompatibilityRequestConfig(model).upstreamModelId;
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const resolution = await this.runtime.getAuth(model);
			const compatibility = this.runtime.getCompatibilityRequestConfig(model, resolution?.env);
			if (!resolution) {
				// Fall back to multi-account credential pool when configured.
				const pooled = await this.authStorage.selectPooledCredential?.(model.provider);
				if (pooled?.apiKey) {
					const headers = {
						...(compatibility.headers
							? Object.fromEntries(
									Object.entries(compatibility.headers).filter(
										(entry): entry is [string, string] => entry[1] !== null,
									),
								)
							: {}),
						...(pooled.headers ?? {}),
					};
					return {
						ok: true,
						apiKey: pooled.apiKey,
						headers: Object.keys(headers).length > 0 ? headers : undefined,
						extraBody: compatibility.extraBody,
					};
				}
				if (compatibility.authHeader) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				const headers = compatibility.headers
					? Object.fromEntries(
							Object.entries(compatibility.headers).filter(
								(entry): entry is [string, string] => entry[1] !== null,
							),
						)
					: undefined;
				return { ok: true, headers, extraBody: compatibility.extraBody };
			}
			const headers = resolution.auth.headers
				? Object.fromEntries(
						Object.entries(resolution.auth.headers).filter(
							(entry): entry is [string, string] => entry[1] !== null,
						),
					)
				: undefined;
			return {
				ok: true,
				apiKey: resolution.auth.apiKey,
				headers,
				extraBody: compatibility.extraBody,
				upstreamModelId: compatibility.upstreamModelId,
				serviceTier: compatibility.serviceTier,
				env: resolution.env,
			};
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const message =
				cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error:
					message === "authHeader requires a resolved API key"
						? `No API key found for "${model.provider}"`
						: message,
			};
		}
	}

	getProviderAuthStatus(provider: string): AuthStatus {
		return this.runtime.getProviderAuthStatus(provider);
	}

	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ?? provider;
	}

	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.runtime.getAuth(provider);
	}

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			return (await this.runtime.getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.authStorage.get(model.provider)?.type === "oauth" || this.runtime.isUsingOAuth(model.provider);
	}

	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		if (typeof providerOrName === "string") {
			if (!config) throw new Error("Provider config is required when registering by name");
			this.runtime.registerProvider(providerOrName, config);
			return;
		}
		this.runtime.registerNativeProvider(providerOrName);
	}

	unregisterProvider(providerName: string): void {
		this.runtime.unregisterProvider(providerName);
	}

	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	getRegisteredProviderIds(): readonly string[] {
		return this.runtime.getRegisteredProviderIds();
	}
}
