import { readFileSync } from "node:fs";

const WSL_ENV_MARKERS: readonly string[] = ["WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV"];

/** Windows Subsystem for Linux session detection that survives sanitized environments (#3628). */
export function isWslSession(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
	procVersionPath = "/proc/version",
): boolean {
	if (platform !== "linux") {
		return false;
	}
	if (WSL_ENV_MARKERS.some((marker) => Boolean(env[marker]))) {
		return true;
	}
	try {
		return /microsoft|wsl/i.test(readFileSync(procVersionPath, "utf-8"));
	} catch {
		return false;
	}
}
