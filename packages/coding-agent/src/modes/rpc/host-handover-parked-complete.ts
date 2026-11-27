/**
 * A park record must carry the launch choices a client-less reopen has no other source for (senpi#7380): the model, the
 * thinking level and the permission preset. A launch profile names only the choices its open passed, so a session opened
 * without them, or moved since (`set_permission_preset`), is completed from its live session (the in-process runtime,
 * or a worker session's last snapshot), so an `ask` session never comes back under this host's defaults and runs gated
 * tools unasked. A choice the live session itself lacks (no model resolved, no preset ever named) is not a loss: the
 * reopen runs under the same host defaults the session ran under. A record is refused only when the profile lacks the
 * model or the thinking level AND the live session cannot be read.
 */
import type { HandoverParkedEntry } from "./host-handover-parked.ts";
import { parkedEntryFromProfile } from "./host-handover-parked-open.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";

type LaunchChoices = Pick<HandoverParkedEntry, "model" | "thinkingLevel" | "permissionPreset">;

export class IncompleteParkRecordError extends Error {
	readonly code = "park_record_incomplete";

	constructor(sessionPath: string, missing: readonly string[]) {
		super(`park record for ${sessionPath} lacks ${missing.join(", ")} and the live session cannot be read`);
		this.name = "IncompleteParkRecordError";
	}
}

function liveChoices(retained: RpcSessionEntry): LaunchChoices | undefined {
	const runtime = retained.runtime;
	if (runtime !== undefined) {
		const model = runtime.session.model;
		const permissionPreset = runtime.launchProfile?.permissionPreset;
		return {
			...(model !== undefined ? { model: { provider: model.provider, modelId: model.id } } : {}),
			thinkingLevel: runtime.session.thinkingLevel,
			...(permissionPreset !== undefined ? { permissionPreset } : {}),
		};
	}
	const state = retained.worker?.snapshot?.state;
	if (state === undefined) return undefined;
	return {
		...(state.model !== undefined ? { model: { provider: state.model.provider, modelId: state.model.id } } : {}),
		thinkingLevel: state.thinkingLevel,
		...(state.permissionPresetSource === "client" ? { permissionPreset: state.permissionPreset } : {}),
	};
}

/** `entry` with every launch choice it lacks taken from the live session; a live preset wins over the profile's. */
export function completeParkedEntry(entry: HandoverParkedEntry, retained: RpcSessionEntry): HandoverParkedEntry {
	const live = liveChoices(retained);
	const permissionPreset = live?.permissionPreset ?? entry.permissionPreset;
	return {
		...entry,
		...(entry.model === undefined && live?.model !== undefined ? { model: live.model } : {}),
		...(entry.thinkingLevel === undefined && live?.thinkingLevel !== undefined
			? { thinkingLevel: live.thinkingLevel }
			: {}),
		...(permissionPreset !== undefined ? { permissionPreset } : {}),
	};
}

export function missingLaunchChoices(entry: HandoverParkedEntry, retained: RpcSessionEntry): readonly string[] {
	if (liveChoices(retained) !== undefined) return [];
	return [
		...(entry.model === undefined ? ["model"] : []),
		...(entry.thinkingLevel === undefined ? ["thinkingLevel"] : []),
	];
}

/** Whether a park of `retained` can write a complete record now; the idle sweep keeps an incomplete one resident. */
export function parkRecordCompletable(retained: RpcSessionEntry): boolean {
	const entry = parkedEntryFromProfile({ sessionPath: retained.sessionPath ?? "" }, retained.profile, []);
	return missingLaunchChoices(entry, retained).length === 0;
}
