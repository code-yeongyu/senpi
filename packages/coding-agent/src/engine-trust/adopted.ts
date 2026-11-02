/**
 * The generation this process adopted, kept in memory because the adopting engine deletes the
 * marker from JS `process.env`. Every spawner that hands the generation on builds from this record,
 * never from `process.env` (omo#10762, design r13 5.4 and 5.5). This module imports nothing at
 * runtime, so the agent-shell path (`utils/bundled-bun.ts`) can read the record without loading
 * the marker parser.
 */
import type { EngineTrustMarker } from "./marker.ts";

let adopted: EngineTrustMarker | undefined;

export function recordAdoptedEngineTrust(marker: EngineTrustMarker): void {
	adopted = marker;
}

export function adoptedEngineTrust(): EngineTrustMarker | undefined {
	return adopted;
}
