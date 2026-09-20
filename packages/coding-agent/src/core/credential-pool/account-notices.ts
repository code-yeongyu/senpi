export interface AccountSwitchNotice {
	type: "account_failover";
	provider: string;
	from: string;
	to: string;
	reason: string;
	sessionId?: string;
	source?: string;
}

export type AccountSwitchListener = (event: AccountSwitchNotice) => void | PromiseLike<void>;

const listeners = new Set<AccountSwitchListener>();

function reportListenerFailure(): void {
	console.error("Account-switch notice observer failed");
}

/**
 * Emit an account switch to every subscriber in isolation. A synchronous throw
 * or async rejection must never stop provider selection, prevent later
 * subscribers from observing the switch, or surface exception text that could
 * carry credential material.
 */
export function emitAccountSwitch(
	event: AccountSwitchNotice,
	observers: Iterable<AccountSwitchListener> = listeners,
): void {
	for (const listener of [...observers]) {
		try {
			const result = listener(event);
			if (result) {
				void Promise.resolve(result).catch(reportListenerFailure);
			}
		} catch {
			reportListenerFailure();
		}
	}
}

export function subscribeAccountSwitch(listener: AccountSwitchListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function formatAccountSwitchNotice({ provider, from, to, reason, source }: AccountSwitchNotice): {
	title: string;
	why: string;
} {
	const why = [`Reason: ${reason}`, source === undefined ? "" : `Source: ${source}`].filter(Boolean).join(" · ");
	return {
		title: `Account fallback: ${provider}/${from} -> ${to}`,
		why,
	};
}
