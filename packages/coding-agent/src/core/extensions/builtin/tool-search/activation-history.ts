import type { HistoryReducer } from "../../../session-history-reduce.ts";
import { type ParsedActivationMarker, parseActivationMarkers } from "./engine/marker.ts";

/**
 * The promotions a session's history holds, by promotion identity in first-seen order (senpi#7600): v2 by name and
 * registration id, legacy by name. The state holds parsed markers only, never an entry or its text, so a tool result
 * that merely quotes the marker text does not stay resident, and it grows with distinct promotions, not with markers
 * written. The session keeps it across extension generations, so a later replay folds just the entries appended since.
 */
export const activationMarkers: HistoryReducer<Map<string, ParsedActivationMarker>> = {
	initial: () => new Map(),
	add: (promotions, entry) => {
		for (const marker of parseActivationMarkers([entry])) {
			// A name sliced out of the serialized entry can keep that whole string alive as its base; a clone holds its own.
			const held = structuredClone(marker);
			if (held.version === 1) {
				for (const name of held.names) promotions.set(`legacy:${name}`, { version: 1, names: [name] });
				continue;
			}
			for (const activation of held.activations) {
				promotions.set(JSON.stringify([activation.name, activation.registrationId]), {
					version: 2,
					activations: [activation],
				});
			}
		}
		return promotions;
	},
};
