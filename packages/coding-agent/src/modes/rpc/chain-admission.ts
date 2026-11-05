import { admitChainCall, CHAIN_COUNT_LIMIT, ChainCountLimitError } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "../../core/settings-manager.ts";

/** A thread call's refusal as an RPC response's `errorCode` and `errorData`. */
export interface ChainRefusal {
	readonly message: string;
	readonly errorCode: typeof CHAIN_COUNT_LIMIT;
	readonly errorData: { readonly count: number; readonly limit: number };
}

export type ChainAdmission =
	| { readonly kind: "admitted"; readonly chainCount?: number }
	| { readonly kind: "refused"; readonly refusal: ChainRefusal };

/**
 * Admits RPC input that may be a thread call from another session (decision K8) against the user's
 * `threads.chainCountLimit`, read at each admission. Every entry that accepts `prompt`, `steer` or `follow_up` runs it
 * before anything of the input is recorded or held. Input without `chainCount` is not a thread call and is admitted.
 */
export function admitInputChain(
	chainCount: number | undefined,
	settings: Pick<SettingsManager, "getThreadChainCountLimit">,
): ChainAdmission {
	if (chainCount === undefined) return { kind: "admitted" };
	try {
		return { kind: "admitted", chainCount: admitChainCall(chainCount, () => settings.getThreadChainCountLimit()) };
	} catch (error) {
		if (!(error instanceof ChainCountLimitError)) throw error;
		return {
			kind: "refused",
			refusal: {
				message: error.message,
				errorCode: CHAIN_COUNT_LIMIT,
				errorData: { count: error.count, limit: error.limit },
			},
		};
	}
}
