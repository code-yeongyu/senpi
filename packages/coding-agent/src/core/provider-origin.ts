/**
 * Where a provider's definition comes from, so a client can say where to change or remove an entry
 * the app cannot delete itself (senpi#4328).
 *
 * - `builtin`: shipped with senpi; `modelsJsonPath`/`extensionPath` name an overlay when one exists.
 * - `extension`: registered by an extension (natively, or as a provider config with no builtin).
 * - `models_json`: defined only in models.json.
 */
export type ProviderOriginKind = "builtin" | "models_json" | "extension";

export interface ProviderOrigin {
	readonly kind: ProviderOriginKind;
	/** The models.json that defines or overrides the provider. */
	readonly modelsJsonPath?: string;
	/** Filesystem path of the registering extension, omitted for synthetic identifiers. */
	readonly extensionPath?: string;
}

export interface ProviderOriginFacts {
	readonly builtin: boolean;
	readonly nativeExtension: boolean;
	/** A provider-config registration or a virtual model from an extension. */
	readonly extension: boolean;
	readonly extensionPath: string | undefined;
	readonly modelsJsonPath: string | undefined;
}

export function providerOriginOf(facts: ProviderOriginFacts): ProviderOrigin | undefined {
	const builtinExtension = facts.extensionPath?.startsWith("<builtin:") === true;
	const extensionPath = facts.extensionPath?.startsWith("<") === true ? undefined : facts.extensionPath;
	const kind: ProviderOriginKind | undefined = builtinExtension
		? "builtin"
		: facts.nativeExtension
			? "extension"
			: facts.builtin
				? "builtin"
				: facts.extension
					? "extension"
					: facts.modelsJsonPath !== undefined
						? "models_json"
						: undefined;
	if (kind === undefined) return undefined;
	return {
		kind,
		...(facts.modelsJsonPath === undefined ? {} : { modelsJsonPath: facts.modelsJsonPath }),
		...(extensionPath === undefined ? {} : { extensionPath }),
	};
}
