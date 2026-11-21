import { rm } from "node:fs/promises";

/**
 * The directory senpi-codemode keeps beside a session file for its eval logs and managed environments
 * (`resolveSessionArtifactsDir` in `packages/senpi-codemode/src/output/output-meta.ts`, senpi#3508). Removing a
 * session removes it too, so deleted eval output does not outlive the session it came from.
 */
export function sessionArtifactsDir(sessionFile: string): string {
	return `${sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -6) : sessionFile}-artifacts`;
}

export async function removeSessionArtifacts(sessionFile: string): Promise<string | undefined> {
	const dir = sessionArtifactsDir(sessionFile);
	try {
		await rm(dir, { recursive: true, force: true });
		return undefined;
	} catch (cause) {
		return `${dir}: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
}
