import type { LifecycleApi, ObligationToken, WorkObligations } from "../session-lifecycle-types.ts";
import { ENGINE_CUSTODY_KEY_PREFIXES } from "../work-obligations.ts";

/** An extension asked for a custody key under a prefix only the engine opens (senpi#3986). */
export class ReservedCustodyKey extends Error {
	readonly key: string;
	constructor(key: string) {
		super(`Custody key is reserved for the engine: ${key}`);
		this.name = "ReservedCustodyKey";
		this.key = key;
	}
}

function assertExtensionKey(key: string): void {
	if (ENGINE_CUSTODY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) throw new ReservedCustodyKey(key);
}

function extensionToken(token: ObligationToken): ObligationToken {
	return {
		transfer(nextKey, kind) {
			assertExtensionKey(nextKey);
			return extensionToken(token.transfer(nextKey, kind));
		},
		ticket: () => token.ticket(),
		heldAsNotice: (noticeId) => token.heldAsNotice(noticeId),
		close: (reason) => token.close(reason),
	};
}

function extensionObligations(obligations: WorkObligations): WorkObligations {
	return {
		open(key, kind, detail) {
			assertExtensionKey(key);
			return extensionToken(obligations.open(key, kind, detail));
		},
	};
}

/** Like other extension actions, resolve the live session only when invoked. */
export function createLifecycleApi(resolve: () => LifecycleApi): LifecycleApi {
	return {
		get obligations() {
			return extensionObligations(resolve().obligations);
		},
		reportChild(report) {
			resolve().reportChild(report);
		},
		markRunCompleted(run) {
			resolve().markRunCompleted(run);
		},
	};
}
