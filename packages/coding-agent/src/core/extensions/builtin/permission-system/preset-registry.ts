import type { PermissionPresetName } from "./types.ts";

/**
 * The preset the permission system enforces for one session, read through `pi.getPermissionPreset()`.
 * Keyed by the session's `SessionManager` like the dispatch authorizers: each extension load
 * registers its own reader, and retiring an older load never removes a newer one.
 */
type PresetReader = () => PermissionPresetName | undefined;

const readers = new WeakMap<object, PresetReader>();

export function registerPermissionPresetReader(session: object, read: PresetReader): () => void {
	readers.set(session, read);
	return () => {
		if (readers.get(session) === read) readers.delete(session);
	};
}

/** `undefined` when no permission system runs for the session, or its setup failed. */
export function readPermissionPreset(session: object): PermissionPresetName | undefined {
	return readers.get(session)?.();
}

/**
 * The preset a gated decision must use instead of the configured one, read at EACH decision (the core's
 * delegated-default rule: `ask` for delegated-origin work on a session no client named a mode for).
 */
const decisionOverrides = new WeakMap<object, PresetReader>();

export function registerDecisionPresetOverride(session: object, read: PresetReader): void {
	decisionOverrides.set(session, read);
}

export function readDecisionPresetOverride(session: object): PermissionPresetName | undefined {
	return decisionOverrides.get(session)?.();
}
