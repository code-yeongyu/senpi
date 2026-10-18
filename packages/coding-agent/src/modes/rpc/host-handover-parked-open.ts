/**
 * The bridge between a handoff-parked session and the host's one open implementation (senpi#3368).
 * A park records the client's `open_session` choices from the session's launch profile; the
 * successor reopens it by replaying exactly those choices as an `open_session`, so the reopened
 * session gets everything any client's open gets: validation, the host-context merge, its kind
 * registered with the event writer, its binding, and the drain's settle wake-up.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { HandoverParkedEntry } from "./host-handover-parked.ts";
import type { RpcCommand } from "./rpc-types.ts";
import type { RpcSessionLaunchProfile } from "./session-registry-types.ts";

type OpenSessionCommand = Extract<RpcCommand, { type: "open_session" }>;

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];
const thinkingLevelOf = (value: string | undefined): ThinkingLevel | undefined =>
	THINKING_LEVELS.find((level) => level === value);

/**
 * The park record of a retained session. `hostContextKeys` are the context keys THIS host merged
 * in on open: they describe this generation and are stripped, so the successor merges its own.
 */
export function parkedEntryFromProfile(
	session: { readonly sessionPath: string; readonly durableSessionId?: string },
	profile: RpcSessionLaunchProfile | undefined,
	hostContextKeys: readonly string[],
): HandoverParkedEntry {
	const clientContext =
		profile?.sessionContext === undefined
			? undefined
			: Object.fromEntries(Object.entries(profile.sessionContext).filter(([key]) => !hostContextKeys.includes(key)));
	return {
		sessionPath: session.sessionPath,
		...(session.durableSessionId !== undefined ? { durableSessionId: session.durableSessionId } : {}),
		retainOnDisconnect: true,
		...(profile?.cwd !== undefined ? { cwd: profile.cwd } : {}),
		...(profile?.creationModel !== undefined ? { model: profile.creationModel } : {}),
		...(profile?.initialThinkingLevel !== undefined ? { thinkingLevel: profile.initialThinkingLevel } : {}),
		...(profile?.permissionPreset !== undefined ? { permissionPreset: profile.permissionPreset } : {}),
		...(profile?.promptSurface !== undefined ? { promptSurface: profile.promptSurface } : {}),
		...(profile?.browserEngine !== undefined ? { browserEngine: profile.browserEngine } : {}),
		...(profile?.sessionKind !== undefined ? { sessionKind: profile.sessionKind } : {}),
		...(clientContext !== undefined && Object.keys(clientContext).length > 0
			? { sessionContext: clientContext }
			: {}),
		...(profile?.autoTitle !== undefined ? { autoTitle: profile.autoTitle } : {}),
		...(profile?.retryFallback !== undefined ? { retryFallback: profile.retryFallback } : {}),
	};
}

/** The `open_session` a parked entry replays on the successor. */
export function parkedOpenCommand(entry: HandoverParkedEntry): OpenSessionCommand {
	const thinkingLevel = thinkingLevelOf(entry.thinkingLevel);
	if (entry.thinkingLevel !== undefined && thinkingLevel === undefined)
		process.stderr.write(
			`senpi rpc successor reopens ${entry.sessionPath} without its unknown thinking level "${entry.thinkingLevel}"\n`,
		);
	const command: OpenSessionCommand = {
		type: "open_session",
		sessionPath: entry.sessionPath,
		...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
		...(entry.durableSessionId !== undefined ? { durableSessionId: entry.durableSessionId } : {}),
		...(entry.model !== undefined ? { provider: entry.model.provider, modelId: entry.model.modelId } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		...(entry.permissionPreset !== undefined ? { permissionPreset: entry.permissionPreset } : {}),
		...(entry.promptSurface !== undefined ? { promptSurface: entry.promptSurface } : {}),
		...(entry.browserEngine !== undefined ? { browserEngine: entry.browserEngine } : {}),
		...(entry.sessionKind !== undefined ? { kind: entry.sessionKind } : {}),
		...(entry.sessionContext !== undefined ? { context: entry.sessionContext } : {}),
		...(entry.autoTitle !== undefined ? { auto_title: entry.autoTitle } : {}),
		...(entry.retryFallback !== undefined ? { retryFallback: entry.retryFallback } : {}),
		retain_on_disconnect: entry.retainOnDisconnect,
	};
	return command;
}
