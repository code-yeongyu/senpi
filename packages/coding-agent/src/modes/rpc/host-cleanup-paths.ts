/**
 * What a host child removes when its supervisor dies without cleaning up, in the order it removes
 * them. The registration pointer comes LAST: every reader takes "no pointer" to mean "this endpoint
 * has no host", so the pointer may only disappear once everything it describes is already gone
 * (senpi#2241).
 */
export interface HostCleanupTargets {
	readonly pointerFile: string;
	readonly generationPidFile: string;
	readonly settingsFile: string;
	readonly publicSocket: string;
	/**
	 * A successor writes no registration of its own until the ensure that spawned it does, and the
	 * files under these paths still describe the generation being replaced.
	 */
	readonly successor: boolean;
	readonly platform: NodeJS.Platform;
}

export function hostCrashCleanupPaths(targets: HostCleanupTargets): string[] {
	// POSIX public sockets are removed ownership-checked by the host child
	// (token: the scratch-directory sidecar plus HOST_PUBLIC_SOCKET_ENV),
	// never by path from a crash-path cleanup: a blind removal here would
	// unlink a newer host's freshly published entry after a takeover.
	// Windows named pipes have no filesystem entry to own, so they stay
	// listed for the crash-path cleanup.
	const publicEntry = targets.platform === "win32" ? [targets.publicSocket] : [];
	if (targets.successor) return publicEntry;
	return [targets.generationPidFile, targets.settingsFile, ...publicEntry, targets.pointerFile];
}
