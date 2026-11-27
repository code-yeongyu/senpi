import type { HistoryReducer } from "../../../session-history-reduce.ts";
import { type ParsedActivationMarker, parseActivationMarkers } from "./engine/marker.ts";

/**
 * The activation markers of a session's history, in append order (senpi#7600). The state is append-only and holds
 * only parsed markers, never an entry or its text: a tool result that merely quotes the marker text would otherwise
 * stay resident for the life of the session. The session keeps the state across extension generations, so a later
 * replay folds just the entries appended since; each reader keeps its own position in it.
 */
export const activationMarkers: HistoryReducer<ParsedActivationMarker[]> = {
	initial: () => [],
	add: (markers, entry) => {
		// A name sliced out of the serialized entry can keep that whole string alive as its base; a copy holds its own.
		for (const marker of parseActivationMarkers([entry])) markers.push(JSON.parse(JSON.stringify(marker)));
		return markers;
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
