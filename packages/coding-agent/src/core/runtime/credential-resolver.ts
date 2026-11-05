export interface CredentialModel {
	provider: string;
	id: string;
	baseUrl: string;
	api?: string;
}

export type CredentialAuthResult =
	| { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }
	| { ok: false; error: string };

export interface ProviderCredential {
	auth: {
		apiKey?: string;
		headers?: Record<string, string | null>;
	};
}

export interface ProviderAuthStatus {
	configured: boolean;
	source?: string;
	ambient?: boolean;
}

/**
 * The credential lookups a tool that calls a provider directly (image generation, native web
 * search) needs, apart from the inference runtime, so a runtime with no session can serve them.
 */
export interface CredentialResolver<TModel extends CredentialModel = CredentialModel> {
	readonly authStorage: { get(provider: string): unknown };
	getAll(): TModel[];
	getAvailable?(): TModel[];
	getApiKeyAndHeaders(model: TModel): Promise<CredentialAuthResult>;
	getProviderAuth(provider: string): Promise<ProviderCredential | undefined>;
	getProviderAuthStatus?(provider: string): ProviderAuthStatus;
	/** Configuration names credential headers and no API key, so no key can be resolved for it. */
	providerAuthIsHeaderOnly?(provider: string): boolean;
}

export function credentialResolverFromRegistry<TModel extends CredentialModel>(
	registry: CredentialResolver<TModel>,
): CredentialResolver<TModel> {
	const { getAvailable, getProviderAuthStatus, providerAuthIsHeaderOnly } = registry;
	return {
		authStorage: { get: (provider) => registry.authStorage.get(provider) },
		getAll: () => registry.getAll(),
		...(getAvailable === undefined ? {} : { getAvailable: () => getAvailable.call(registry) }),
		getApiKeyAndHeaders: (model) => registry.getApiKeyAndHeaders(model),
		getProviderAuth: (provider) => registry.getProviderAuth(provider),
		...(getProviderAuthStatus === undefined
			? {}
			: { getProviderAuthStatus: (provider) => getProviderAuthStatus.call(registry, provider) }),
		...(providerAuthIsHeaderOnly === undefined
			? {}
			: { providerAuthIsHeaderOnly: (provider) => providerAuthIsHeaderOnly.call(registry, provider) }),
	};
}
