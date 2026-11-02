import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";

const directories = new Set<string>();
const cleanups = new Set<() => void>();
// File-scoped fixtures may be created at module evaluation, before any test is active.
// Vitest setup registers teardown; real subprocess fixtures keep their explicit cleanup.
// The removal is awaited so a package's test setup can join work still writing into a tracked tree first
// (coding-agent waits for in-flight host gc passes, senpi#4382); a synchronous removal could not wait.
export async function cleanupTempDirs(): Promise<void> {
	for (const cleanup of [...cleanups].reverse()) cleanup();
	for (const directory of directories) {
		await rm(directory, { recursive: true, force: true, maxRetries: 3 });
		directories.delete(directory);
	}
}

export function onTempCleanup(cleanup: () => void): void {
	cleanups.add(cleanup);
}

export function makeTempDir(prefix: string): string {
	const directory = mkdtempSync(prefix);
	directories.add(directory);
	return directory;
}

export function trackTempDir(directory: string): void {
	directories.add(directory);
}
