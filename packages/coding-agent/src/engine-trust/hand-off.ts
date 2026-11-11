import { adoptedEngineTrust } from "./adopted.ts";
import { buildTrustLaunchEnvironment } from "./launch-environment.ts";
import type { EngineTrustMarker } from "./marker.ts";

/**
 * The entries a daemon or handover successor is forced to receive: the generation, a marker with
 * an empty `restore` (a daemon's allowlist must not be bypassed by restored values) and no hop
 * (a hand-off may still make one trust exec of its own).
 */
export function engineTrustHandOffEnvironment(
	marker: EngineTrustMarker,
	platform: NodeJS.Platform,
): Record<string, string> {
	return buildTrustLaunchEnvironment({}, { marker: { ...marker, restore: {} }, hop: false, platform });
}

/**
 * The hand-off for the generation this process adopted, or nothing when it adopted none. Every senpi
 * spawn of an engine (initial daemon, handover successor, a supervisor's host child) builds from
 * this one function: an engine that arrives without the generation imports it again and re-execs,
 * and that exec closes every inherited descriptor above stdio (senpi#6312).
 */
export function adoptedEngineTrustHandOff(platform: NodeJS.Platform = process.platform): Record<string, string> {
	const marker = adoptedEngineTrust();
	return marker === undefined ? {} : engineTrustHandOffEnvironment(marker, platform);
}
