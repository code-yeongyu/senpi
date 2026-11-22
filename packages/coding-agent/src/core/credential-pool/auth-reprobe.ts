/**
 * How long a rejected credential sits out before one request probes it again
 * (senpi#3264). A token is often refreshed outside this process (the Claude
 * Code config directory, another login), so an auth block that only a token
 * write could clear stranded healthy accounts for hours. A failed probe costs
 * one fast 401 and re-blocks for the same interval.
 */
export const AUTH_BLOCK_REPROBE_MS = 15 * 60_000;
