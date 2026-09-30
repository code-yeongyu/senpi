import { AsyncLocalStorage } from "node:async_hooks";
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
	OAuthAuth,
} from "@earendil-works/pi-ai";
import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { emitCredentialAccountUpdate } from "./credential-account-events.ts";

type ExtensionOAuthRegistry = {
	registerOAuthProvider(providerId: string, oauth: OAuthAuth): void;
	unregisterOAuthProvider(providerId: string): void;
};

function asExtensionOAuthRegistry(store: CredentialStore): ExtensionOAuthRegistry | undefined {
	const candidate = store as CredentialStore & Partial<ExtensionOAuthRegistry>;
	return typeof candidate.registerOAuthProvider === "function" &&
		typeof candidate.unregisterOAuthProvider === "function"
		? (candidate as ExtensionOAuthRegistry)
		: undefined;
}
/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();
	private readonly accountObservation = new AsyncLocalStorage<
		(provider: string, credential: Credential | undefined) => void
	>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	getCredentialEventScope(): object | string {
		const storage = this.store as CredentialStore & { getStoragePath?: () => string | undefined };
		return storage.getStoragePath?.() ?? this.store;
	}

	private notifyOverride(provider: string): void {
		emitCredentialAccountUpdate({
			scope: this.getCredentialEventScope(),
			update: { type: "credential_accounts_changed", provider, reason: "credentials" },
		});
	}

	registerOAuthProvider(providerId: string, oauth: OAuthAuth): void {
		asExtensionOAuthRegistry(this.store)?.registerOAuthProvider(providerId, oauth);
	}

	unregisterOAuthProvider(providerId: string): void {
		asExtensionOAuthRegistry(this.store)?.unregisterOAuthProvider(providerId);
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
		this.notifyOverride(providerId);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
		this.notifyOverride(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	/** Observe the exact stored read used by auth resolution, without guessing from another read or token equality. */
	async observeAccount<T>(provider: string, resolve: () => Promise<T>): Promise<{ value: T; name?: string }> {
		let name: string | undefined;
		const value = await this.accountObservation.run((readProvider, credential) => {
			if (readProvider !== provider) return;
			const slots = listSlots(credential);
			name = slots.length === 1 ? slots[0]?.name : undefined;
		}, resolve);
		return { value, ...(name === undefined ? {} : { name }) };
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const override = this.overrides.get(providerId);
		if (override) return { type: "api_key", key: override };
		const observe = this.accountObservation.getStore();
		if (!observe) return this.store.read(providerId, options);
		const storage = this.store as CredentialStore & { hasRuntimeApiKey?: (provider: string) => boolean };
		if (storage.hasRuntimeApiKey?.(providerId)) return this.store.read(providerId, options);
		const credential = await this.store.read(providerId, options);
		observe(providerId, credential);
		return credential;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		options?.signal?.throwIfAborted();
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn, options);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.store.delete(providerId, options);
		this.overrides.delete(providerId);
	}
}
