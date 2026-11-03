import type { SdkErrorKind } from "./errors.ts";

export type ProviderAccountsChangedEvent = {
	readonly type: "accounts_changed";
	readonly provider: string;
	/** Only a successful login or an explicit block reset invalidates session holds. */
	readonly remedy?: "login" | "reset";
};

export type ProviderAccountFailoverEvent = {
	readonly type: "failover";
	readonly provider: string;
	readonly from: string;
	readonly to: string;
	readonly reason: SdkErrorKind;
};

export type ProviderAccountEvent = ProviderAccountsChangedEvent | ProviderAccountFailoverEvent;

type ProviderAccountEventListener = (event: ProviderAccountEvent) => void;

const listeners = new Set<ProviderAccountEventListener>();

export function subscribeProviderAccountEvents(listener: ProviderAccountEventListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function emitProviderAccountsChanged(provider: string, remedy?: ProviderAccountsChangedEvent["remedy"]): void {
	emit({ type: "accounts_changed", provider, ...(remedy === undefined ? {} : { remedy }) });
}

export function emitProviderAccountFailover(provider: string, from: string, to: string, reason: SdkErrorKind): void {
	emit({ type: "failover", provider, from, to, reason });
}

function emit(event: ProviderAccountEvent): void {
	for (const listener of listeners) listener(event);
}
