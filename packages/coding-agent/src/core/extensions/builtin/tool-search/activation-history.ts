import type { EventLoopSlicer } from "../../../event-loop-slicer.ts";
import type { HistoryReducer } from "../../../session-history-reduce.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import { type ParsedActivationMarker, parseActivationMarkers } from "./engine/marker.ts";

/** Each read folds new entries and immediately drains them in slices. Only distinct promotion identities survive. */
class ActivationHistory {
	readonly markers = new Map<string, ParsedActivationMarker>();
	readonly unread: SessionEntry[] = [];

	async scan(slicer: EventLoopSlicer): Promise<void> {
		while (this.unread.length > 0) {
			// Replay checks membership against today's catalog and sorts the result, independent of entry order.
			for (const marker of parseActivationMarkers([this.unread.pop()])) {
				if (marker.version === 1) {
					for (const name of marker.names) this.markers.set(`legacy:${name}`, { version: 1, names: [name] });
				} else {
					for (const activation of marker.activations) {
						const key = JSON.stringify([activation.name, activation.registrationId]);
						this.markers.set(key, { version: 2, activations: [activation] });
					}
				}
			}
			if (slicer.due) await slicer.yield();
		}
	}
}

export const activationHistory: HistoryReducer<ActivationHistory> = {
	initial: () => new ActivationHistory(),
	add: (state, entry) => {
		state.unread.push(entry);
		return state;
	},
};
