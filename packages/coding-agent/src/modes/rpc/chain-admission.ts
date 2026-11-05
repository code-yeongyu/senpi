import { admitChainCall, CHAIN_COUNT_LIMIT, ChainCountLimitError } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "../../core/settings-manager.ts";

/** The refusal reason of a thread call whose `chainCount` is not a positive safe integer (1 is a chain's first hop). */
const INVALID_CHAIN_COUNT = "invalid_chain_count";

/** A thread call's refusal as an RPC response's `errorCode` and `errorData`. */
export type ChainRefusal =
	| {
			readonly message: string;
			readonly errorCode: typeof CHAIN_COUNT_LIMIT;
			readonly errorData: { readonly count: number; readonly limit: number };
	  }
	| {
			readonly message: string;
			readonly errorCode: typeof INVALID_CHAIN_COUNT;
			readonly errorData: { readonly chainCount: unknown };
	  };

export type ChainAdmission =
	| { readonly kind: "admitted"; readonly chainCount?: number }
	| { readonly kind: "refused"; readonly refusal: ChainRefusal };

/**
 * Admits RPC input that may be a thread call from another session (decision K8) against the user's
 * `threads.chainCountLimit`, read at each admission. Every entry that accepts `prompt`, `steer` or `follow_up` runs it
 * before anything of the input is recorded or held. Input without `chainCount` is not a thread call and is admitted.
 */
export function admitInputChain(
	chainCount: unknown,
	settings: Pick<SettingsManager, "getThreadChainCountLimit">,
): ChainAdmission {
	if (chainCount === undefined) return { kind: "admitted" };
	// The RPC boundary only shape-checks a command, so a count arrives unvalidated: a malformed one never compares above
	// the limit and would be admitted, so it is refused here before the limit is read.
	if (typeof chainCount !== "number" || !Number.isSafeInteger(chainCount) || chainCount < 1)
		return {
			kind: "refused",
			refusal: {
				message: `chainCount must be a positive integer (1 for a chain's first hop), not ${JSON.stringify(chainCount)}`,
				errorCode: INVALID_CHAIN_COUNT,
				errorData: { chainCount },
			},
		};
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
