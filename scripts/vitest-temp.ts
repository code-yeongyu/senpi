import { mkdtempSync, rmSync } from "node:fs";
import { afterAll } from "vitest";

const directories = new Set<string>();
// File-scoped fixtures may be created at module evaluation, before any test is active.
// The teardown also runs after failed assertions; the outer runner covers killed workers.
afterAll(() => {
	for (const directory of directories) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
		directories.delete(directory);
	}
});

export function makeTempDir(prefix: string): string {
	const directory = mkdtempSync(prefix);
	directories.add(directory);
	return directory;
}

export function trackTempDir(directory: string): void {
	directories.add(directory);
}
