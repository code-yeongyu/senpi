/**
 * Which install a host runs, and whether it is still on disk (senpi#7086). `runtimeBuildId` is a content digest, so two
 * installs of one build at different paths share it: a host started from one keeps serving when the other asks. That is
 * right while the serving install exists (two live installs must not hand the host back and forth) and wrong once it is
 * gone, because the host then runs a deleted tree. `installGoneReplaces` (`host-install-rule.ts`) is the one rule every path asks.
 */
import { access } from "node:fs/promises";
import { loadedRuntimeSource } from "./runtime-build-id.ts";

export interface HostInstall {
	/** The runtime root this process loaded: the compiled binary, or the package's `dist` / source tree. */
	readonly path: string;
	readonly present: boolean;
}

export function runningInstallPath(): string {
	return loadedRuntimeSource().root;
}

export async function readHostInstall(path: string): Promise<HostInstall> {
	try {
		await access(path);
		return { path, present: true };
	} catch {
		return { path, present: false };
	}
}
