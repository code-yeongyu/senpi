import { automountTriggerPathSync, withResolutionDeadline } from "@code-yeongyu/senpi-machine-ops";
import { access } from "node:fs/promises";
import { RpcSessionRegistryError } from "./session-registry-types.ts";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The key a session file is reserved under: one key for every spelling of one file (macOS
 * `/tmp` vs `/private/tmp`, a symlinked workspace root). A path whose directory is gone keeps
 * its missing tail verbatim under the deepest ancestor that still exists, so another session's
 * deleted directory can never fail a listing or an open (senpi#2206). A socket host names its public
 * endpoint's directory the same way, so a first generation that starts before that directory exists
 * and a successor that starts after it stamp one `host_socket`.
 */
export function canonicalSessionPath(path: string): string {
	const absolutePath = resolve(path);
	const missing: string[] = [];
	let existing = absolutePath;
	// A component under an unmounted automount names nothing on this machine; probing it would park the host thread.
	while (automountTriggerPathSync(existing) !== undefined || !existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return absolutePath;
		missing.unshift(basename(existing));
		existing = parent;
	}
	try {
		return join(realpathSync(existing), ...missing);
	} catch {
		// A delete racing the existence check leaves the given spelling as the only one; a key
		// that misses an alias still beats a listing that throws.
		return absolutePath;
	}
}

/**
 * The directories of these session files that are gone: a session there can never persist again. Checked off the host
 * thread (senpi#4565): a directory under an unmounted automount is gone, and one that does not answer within the
 * resolution deadline counts as present, so a hung mount never ends a session or parks the host.
 */
export async function removedSessionDirectories(sessionFiles: readonly string[]): Promise<ReadonlySet<string>> {
	const removed = new Set<string>();
	await Promise.all(
		[...new Set(sessionFiles.map((file) => dirname(file)))].map(async (directory) => {
			if (automountTriggerPathSync(directory) !== undefined) {
				removed.add(directory);
				return;
			}
			const gone = await withResolutionDeadline(
				access(directory).then(
					() => false,
					() => true,
				),
			);
			if (gone === true) removed.add(directory);
		}),
	);
	return removed;
}

/** The "transcript directory is gone" test over a set {@link removedSessionDirectories} answered. */
export function sessionDirectoryRemovedIn(removed: ReadonlySet<string>): (sessionFile: string) => boolean {
	return (sessionFile) => removed.has(dirname(sessionFile));
}

/**
 * Refuse a session whose cwd or file lies under an unmounted automount trigger (senpi#4565): a path of another
 * machine (a Linux `/home/<user>/...` handed to a macOS host) names nothing here, and every synchronous probe of it
 * would park the host thread.
 */
export function assertSessionPathsOnThisMachine(profile: {
	readonly cwd: string;
	readonly sessionPath?: string;
}): void {
	for (const path of [profile.cwd, profile.sessionPath]) {
		if (path !== undefined && automountTriggerPathSync(path) !== undefined)
			throw new RpcSessionRegistryError("invalid_path", undefined, { reason: "automount_not_mounted", path });
	}
}
