import type { AgentSessionLaunchProfile } from "./agent-session-runtime.ts";

export function sessionExtensionFlagValues(
	hostFlags: ReadonlyMap<string, boolean | string>,
	launchProfile: Readonly<AgentSessionLaunchProfile> | undefined,
): Map<string, boolean | string> {
	const flags = new Map(hostFlags);
	if (launchProfile?.permissionPreset !== undefined) flags.set("permission-preset", launchProfile.permissionPreset);
	return flags;
}
