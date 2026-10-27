/**
 * The launch capabilities this build reports to a launcher (sisyphuslabs/omo-desktop-app#4199, design section 5 "Mixed
 * versions", final paragraph). A launcher runs the selected command, wrapper included, with
 * `--launch-capabilities --version` before it chooses the parent-admitted reservation route. This build answers with one
 * JSON line and exits before anything else runs; an older runtime ignores the unknown flag and answers its root
 * `--version` with a version line, which is its recognized legacy result. Both answers are side-effect free.
 *
 * A leaf with no imports: `cli.ts` answers the probe before it loads anything else.
 */
export const SOCKET_SECRET_RESERVATION_V1 = "socket_secret_reservation_v1";
export const PARTICIPANT_LIFETIME_LOCKS_V1 = "participant_lifetime_locks_v1";
export const LAUNCH_CAPABILITIES_FLAG = "--launch-capabilities";

/**
 * What this build implements on `platform`. The reservation launch and its participant lifetime locks exist for Windows
 * public endpoints only (Revision 7 scope); POSIX has no public secret file, and its lifetime locks and identity adapter
 * are the conditional contract #4199 does not implement, so a POSIX build reports neither.
 */
export function launchCapabilities(platform: NodeJS.Platform): readonly string[] {
	return platform === "win32" ? [SOCKET_SECRET_RESERVATION_V1, PARTICIPANT_LIFETIME_LOCKS_V1] : [];
}

/** The probe's answer line when `args` is the probe, otherwise `undefined`. */
export function launchCapabilityProbeAnswer(
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (!args.includes(LAUNCH_CAPABILITIES_FLAG) || !args.includes("--version")) return undefined;
	return JSON.stringify({ launch_capabilities: launchCapabilities(platform) });
}
