import type { HistoryReducer } from "../../../session-history-reduce.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import type { ParsedActivationMarker } from "./engine/marker.ts";
import { mayHoldActivationMarker } from "./engine/marker-candidates.ts";

/**
 * The entries of a session's history that may hold an activation marker, in append order (senpi#7600). The state is
 * append-only and holds only the rare candidates, so the session keeps it across extension generations and a later
 * replay folds just the entries appended since; each reader keeps its own position in it.
 */
export const activationCandidates: HistoryReducer<SessionEntry[]> = {
	initial: () => [],
	add: (candidates, entry) => {
		if (mayHoldActivationMarker(entry)) candidates.push(entry);
		return candidates;
	},
};

/** Adds a marker under its promotion identity, so the same promotion read twice is held once. */
export function holdActivationMarker(
	markers: Map<string, ParsedActivationMarker>,
	marker: ParsedActivationMarker,
): void {
	if (marker.version === 1) {
		for (const name of marker.names) markers.set(`legacy:${name}`, { version: 1, names: [name] });
		return;
	}
	for (const activation of marker.activations) {
		markers.set(JSON.stringify([activation.name, activation.registrationId]), {
			version: 2,
			activations: [activation],
		});
	}
}
