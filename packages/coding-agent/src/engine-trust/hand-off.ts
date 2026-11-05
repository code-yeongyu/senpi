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
