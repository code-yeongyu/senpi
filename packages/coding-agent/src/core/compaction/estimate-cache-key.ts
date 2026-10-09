import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** The message's JSON text, or undefined when it cannot be serialized (such a message is never cached). */
export function serializeForEstimate(message: AgentMessage): string | undefined {
	try {
		return JSON.stringify(message);
	} catch {
		return undefined;
	}
}

type BunHash = { wyhash(input: string, seed: bigint): bigint };
const bunHash: BunHash | undefined = (globalThis as { Bun?: { hash?: BunHash } }).Bun?.hash;

/**
 * The reuse key for the per-message estimate caches, derived from the message's JSON text: it differs
 * whenever any estimate-relevant field differs (strings of any length, numbers, booleans, shape), including
 * the resident store's in-place token/text swaps. Under Bun the key is the text's length plus a 128-bit
 * digest (two seeded wyhash passes), so a cache entry does not hold a second copy of the message's text
 * (review of senpi#2884: the text key retained about 1.4x the message's JSON per cached message). Other
 * runtimes keep the exact text. The input must be `JSON.stringify` output: Bun.hash maps lone surrogates
 * to U+FFFD, and JSON serialization escapes them, so distinct messages never meet that collision.
 */
export function estimateCacheKey(serialized: string): string {
	if (bunHash === undefined) return serialized;
	return `${serialized.length}:${bunHash.wyhash(serialized, 1n).toString(36)}:${bunHash.wyhash(serialized, 2n).toString(36)}`;
}

/**
 * Messages that exist for one request only: the runner's per-turn deep clone when a `context` handler has
 * not declared `mutatesMessages: false`, and admission's sizing probes. Each is a fresh object, so an
 * estimate cache keyed on it can never hit; the estimators compute such messages directly instead of
 * paying for a key and a cache entry (review of senpi#2884, M1). The marker is a non-enumerable symbol
 * property: serialization, spreads and deep equality all ignore it, so it never reaches a request or a key.
 */
const TRANSIENT = Symbol("senpi.transientEstimateMessage");

export function markTransientMessage<T extends AgentMessage>(message: T): T {
	Object.defineProperty(message, TRANSIENT, { value: true });
	return message;
}

export function isTransientMessage(message: AgentMessage): boolean {
	return (message as AgentMessage & { [TRANSIENT]?: true })[TRANSIENT] === true;
}
