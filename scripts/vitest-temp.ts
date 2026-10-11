import { mkdtempSync, rmSync } from "node:fs";

const directories = new Set<string>();
const cleanups = new Set<() => void>();
// File-scoped fixtures may be created at module evaluation, before any test is active.
// Vitest setup registers teardown; real subprocess fixtures keep their explicit cleanup.
export function cleanupTempDirs(): void {
	for (const cleanup of [...cleanups].reverse()) cleanup();
	for (const directory of directories) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
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
