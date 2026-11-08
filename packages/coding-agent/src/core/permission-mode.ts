import { parsePermissionPresetName } from "./extensions/builtin/permission-system/cli.ts";
import { readPermissionPreset } from "./extensions/builtin/permission-system/preset-registry.ts";
import { resolvePermissionPreset } from "./extensions/builtin/permission-system/settings.ts";
import type { PermissionPresetName } from "./extensions/builtin/permission-system/types.ts";
import { bindDecisionPreset } from "./permission-decision.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** `client`: a client named a valid preset for this session. `host_default`: the host's own default applies. */
export type PermissionPresetSource = "client" | "host_default";
/** `invalid`: the named preset (or the host's settings) cannot be parsed; every gated tool call is refused. */
export type PermissionPresetStatus = "applied" | "invalid";

/** The approval mode a session enforces, as `get_state`, the open reply and `set_permission_preset` report it. */
export interface PermissionMode {
	readonly permissionPreset: string;
	readonly permissionPresetSource: PermissionPresetSource;
	readonly permissionPresetStatus: PermissionPresetStatus;
	/** What the next gated decision uses; `null` while the setup is invalid (every gated call is refused). */
	readonly effectivePermissionPreset: PermissionPresetName | null;
}

/** The mode fields `set_permission_preset` and the open reply confirm a requested preset by. */
export type PermissionModeReply = Pick<
	PermissionMode,
	"permissionPreset" | "permissionPresetSource" | "permissionPresetStatus"
>;

const PERMISSION_PRESET_FLAG = "permission-preset";
const PERMISSION_PRESET_CHANGED_CHANNEL = "permission_preset_changed";
const PERMISSION_MODE_ENTRY = "permission_mode";

type ModeSession = Parameters<typeof permissionModeOf>[0] & {
	readonly sessionManager: Pick<SessionManager, "getEntries" | "appendCustomEntry" | "getHeader" | "getSessionId">;
	readonly extensionRunner: { emitBusEvent(channel: string, data: unknown): void };
};

const clientPresets = new WeakMap<object, string>();
// Sessions whose `permission-preset` flag holds the host's own default (an embedder's host option), not an operator flag.
const hostDefaultFlagSessions = new WeakSet<object>();

export function markHostDefaultPresetFlag(
	session: object,
	profile: { readonly permissionPresetSource?: "host_default" } | undefined,
): void {
	if (profile?.permissionPresetSource === "host_default") hostDefaultFlagSessions.add(session);
	else hostDefaultFlagSessions.delete(session);
}

function markClientPermissionPreset(session: object, preset: string | undefined): void {
	if (preset === undefined) clientPresets.delete(session);
	else clientPresets.set(session, preset);
}

export function permissionModeOf(session: {
	readonly sessionManager: object;
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: { getFlagValues(): ReadonlyMap<string, boolean | string> };
}): PermissionMode {
	const named = clientPresets.get(session);
	const namedPreset = named === undefined ? undefined : parsePermissionPresetName(named);
	if (namedPreset !== undefined) return clientMode(namedPreset, readPermissionPreset(session.sessionManager));
	const hostFlag = named === undefined ? session.extensionRunner.getFlagValues().get(PERMISSION_PRESET_FLAG) : named;
	const hostPreset = typeof hostFlag === "string" ? parsePermissionPresetName(hostFlag) : undefined;
	if (typeof hostFlag === "string" && hostPreset === undefined) return invalidMode(hostFlag);
	let preset: PermissionPresetName;
	try {
		preset = resolvePermissionPreset(session.settingsManager, hostPreset);
	} catch {
		return invalidMode(typeof hostFlag === "string" ? hostFlag : "");
	}
	return {
		permissionPreset: preset,
		permissionPresetSource: "host_default",
		permissionPresetStatus: "applied",
		effectivePermissionPreset: readPermissionPreset(session.sessionManager) ?? preset,
	};
}

// The live permission system is the authority on what it enforces; the named preset stands in only while no
// permission system has registered for the session yet (it loads with the session's extensions).
function clientMode(preset: PermissionPresetName, enforced: PermissionPresetName | undefined): PermissionMode {
	return {
		permissionPreset: preset,
		permissionPresetSource: "client",
		permissionPresetStatus: "applied",
		effectivePermissionPreset: enforced ?? preset,
	};
}

// An invalid preset never counts as one a client set: rule 1 of the delegated-default design must never select an
// unusable preset, so the source stays the host's while every gated call is refused (#2617).
function invalidMode(preset: string): PermissionMode {
	return {
		permissionPreset: preset,
		permissionPresetSource: "host_default",
		permissionPresetStatus: "invalid",
		effectivePermissionPreset: null,
	};
}

/** The preset a launch profile names as a client's choice; an embedder's host default is not one. */
export function clientNamedPreset(
	profile: { readonly permissionPreset?: string; readonly permissionPresetSource?: "host_default" } | undefined,
): string | undefined {
	return profile?.permissionPresetSource === "host_default" ? undefined : profile?.permissionPreset;
}

/** A profile whose preset a client just named: the host-default marker no longer applies. */
export function withClientPreset<
	P extends { readonly permissionPreset?: string; readonly permissionPresetSource?: "host_default" },
>(profile: P, preset: string): Readonly<P> {
	const { permissionPresetSource: _hostDefault, ...rest } = profile;
	return Object.freeze({ ...rest, permissionPreset: preset } as P);
}

export function permissionModeReply(mode: PermissionMode): PermissionModeReply {
	return {
		permissionPreset: mode.permissionPreset,
		permissionPresetSource: mode.permissionPresetSource,
		permissionPresetStatus: mode.permissionPresetStatus,
	};
}

function persistedClientPreset(sessionManager: Pick<SessionManager, "getEntries">): string | undefined {
	const entries = sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== PERMISSION_MODE_ENTRY) continue;
		const data: unknown = entry.data;
		if (typeof data !== "object" || data === null || !("preset" in data)) return undefined;
		return typeof data.preset === "string" && parsePermissionPresetName(data.preset) ? data.preset : undefined;
	}
	return undefined;
}

export function openReplyPermissionMode(state: Partial<PermissionMode>): Partial<PermissionModeReply> {
	const { permissionPreset, permissionPresetSource, permissionPresetStatus } = state;
	if (permissionPreset === undefined || permissionPresetSource === undefined || permissionPresetStatus === undefined)
		return {};
	return { permissionPreset, permissionPresetSource, permissionPresetStatus };
}

/**
 * Binds the preset a client named to the live session: reported as `client`, persisted to its file, and, for a change
 * to a running session (`announce`), published on the session's `permission_preset_changed` bus channel.
 */
/** Binds the per-decision approval-mode rule to a session, wherever it was created (runtime, SDK, in-process child). */
export function bindPermissionDecision(session: ModeSession): void {
	bindDecisionPreset({
		sessionManager: session.sessionManager,
		namedPreset: () => clientPresets.get(session),
		launchFlagNamed: () =>
			!hostDefaultFlagSessions.has(session) &&
			typeof session.extensionRunner.getFlagValues().get(PERMISSION_PRESET_FLAG) === "string",
		recordedPreset: () => persistedClientPreset(session.sessionManager),
	});
}

export function applyClientPermissionMode(
	session: ModeSession,
	preset: string | undefined,
	options: { readonly announce: boolean },
): void {
	markClientPermissionPreset(session, preset);
	persistClientPreset(session.sessionManager, preset);
	bindPermissionDecision(session);
	if (options.announce)
		session.extensionRunner.emitBusEvent(PERMISSION_PRESET_CHANGED_CHANNEL, permissionModeOf(session));
}

/**
 * Records a valid client-named preset as a `permission_mode` custom entry (bookkeeping only: nothing restores it
 * on a later open). Writes only on a change; an invalid preset is never recorded.
 */
function persistClientPreset(
	sessionManager: Pick<SessionManager, "getEntries" | "appendCustomEntry">,
	preset: string | undefined,
): void {
	if (preset === undefined || parsePermissionPresetName(preset) === undefined) return;
	if (persistedClientPreset(sessionManager) === preset) return;
	sessionManager.appendCustomEntry(PERMISSION_MODE_ENTRY, { preset, source: "client" }, { startupBookkeeping: true });
}
