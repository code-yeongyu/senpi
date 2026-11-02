import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";

/**
 * SECURITY: `dlopen()` on a quarantined, non-notarized addon hands control to
 * Gatekeeper, which suspends the process behind an "Apple could not verify ... is
 * free of malware" dialog instead of returning an error. Senpi's prebuilds carry
 * only a linker ad-hoc signature, so a quarantined prebuild is never auto-approved.
 * Detection MUST NOT become removal: clearing the attribute would silently defeat
 * the user's malware protection.
 *
 * Node exposes no `getxattr` binding, so `xattr -p` is the only available channel;
 * it exits 0 only when the attribute is present. Any spawn failure returns `false`
 * so an unreadable attribute never rejects an otherwise loadable prebuild.
 */
export function isQuarantinedNativeFile(modulePath: string, platform: string = process.platform): boolean {
	if (platform !== "darwin") return false;
	if (!existsSync(modulePath)) return false;

	const probe = spawnSync("/usr/bin/xattr", ["-p", QUARANTINE_ATTRIBUTE, modulePath], {
		stdio: ["ignore", "ignore", "ignore"],
		timeout: 2000,
	});

	return probe.error === undefined && probe.status === 0;
}
