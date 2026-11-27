import { envValue } from "./brand.ts";

/**
 * The engine-socket compact-updates rollout flag (`<brand>_ENGINE_SOCKET_COMPACT_UPDATES`), explicit-true only.
 * Off, no session runs internal capture, mints recovery identities or owns an acceptance lane, in process or in a
 * worker, and every destination keeps its bytes (RULING-112).
 */
export function compactUpdatesEnabled(): boolean {
	const value = envValue("ENGINE_SOCKET_COMPACT_UPDATES");
	return value === "1" || value === "true";
}
