import { readFileSync } from "node:fs";

/** Windows Subsystem for Linux, where Windows executables are reachable through interop. Linux-only by contract: callers on other platforms must guard with a platform check (as keybindings and the footer provider do), because `WSLENV` can also be set on native Windows. */
export function isWSL(env: NodeJS.ProcessEnv = process.env, procVersionPath = "/proc/version"): boolean {
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV) {
		return true;
	}

	try {
		const release = readFileSync(procVersionPath, "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}
