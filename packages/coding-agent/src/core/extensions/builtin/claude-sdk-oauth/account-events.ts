import type { SdkErrorKind } from "./errors.ts";

export type ProviderAccountsChangedEvent = {
	readonly type: "accounts_changed";
	readonly provider: string;
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
const PROVIDER_ACCOUNT_EVENT_BRIDGE = Symbol.for("senpi.provider-account-events.emit.v1");

type ProviderAccountEventGlobal = typeof globalThis & {
	[PROVIDER_ACCOUNT_EVENT_BRIDGE]?: (event: ProviderAccountEvent) => void;
};

const eventGlobal = globalThis as ProviderAccountEventGlobal;
if (!eventGlobal[PROVIDER_ACCOUNT_EVENT_BRIDGE]) {
	Object.defineProperty(eventGlobal, PROVIDER_ACCOUNT_EVENT_BRIDGE, {
		value: (event: ProviderAccountEvent) => emit(event),
		enumerable: false,
		configurable: false,
		writable: false,
	});
}

export function subscribeProviderAccountEvents(listener: ProviderAccountEventListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function emitProviderAccountsChanged(provider: string): void {
	emit({ type: "accounts_changed", provider });
}

export function emitProviderAccountFailover(provider: string, from: string, to: string, reason: SdkErrorKind): void {
	emit({ type: "failover", provider, from, to, reason });
}

function emit(event: ProviderAccountEvent): void {
	for (const listener of listeners) listener(event);
}
