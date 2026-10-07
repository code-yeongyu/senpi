/** Options accepted by the devin-agent (Cascade) API. */

import type { StreamOptions } from "../../types.ts";

export interface DevinAgentOptions extends StreamOptions {
	/** Devin CLI session token. Prefixed on the wire when it is not already. */
	apiKey?: string;
	/**
	 * Cascade conversation id. Threads a multi-turn exchange server-side and
	 * seeds deterministic message ids; a fresh id starts a new transcript.
	 */
	cascadeId?: string;
}
