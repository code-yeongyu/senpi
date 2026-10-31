import { envValue } from "./brand.ts";

/**
 * The engine-socket compact-updates rollout flag (`<brand>_ENGINE_SOCKET_COMPACT_UPDATES`), explicit-true only.
 * Off, no socket selects compact updates and every destination keeps its bytes; internal capture, recovery identity
 * and acceptance still run for every session that has a structured lane.
 */
export function compactUpdatesEnabled(): boolean {
	const value = envValue("ENGINE_SOCKET_COMPACT_UPDATES");
	return value === "1" || value === "true";
}
