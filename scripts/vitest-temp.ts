import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";

const directories = new Set<string>();
const cleanups = new Set<() => void>();

/** Work that may still write into a tracked directory; its removal waits for it (senpi#3570). */
type Settler = { readonly settled: () => Promise<void>; readonly writer: () => string; readonly deadlineMs: number };
const settlers = new Map<string, Settler>();

/** Under vitest's default 10 s hookTimeout, so an expired wait fails here with the writer named, not as a hook timeout. */
export const SETTLE_DEADLINE_MS = 8_000;

/**
 * Removes `directory` only after `settled` resolves. On the deadline the removal fails naming `writer()` and the
 * directory stays for inspection: a removal while the writer still runs is exactly the ENOTEMPTY race.
 */
export function settleBeforeRemoval(
	directory: string,
	settled: () => Promise<void>,
	writer: () => string,
	deadlineMs = SETTLE_DEADLINE_MS,
): void {
	settlers.set(directory, { settled, writer, deadlineMs });
}

async function settleThenRemove(directory: string, settler: Settler): Promise<string | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"expired">((resolve) => {
		timer = setTimeout(() => resolve("expired"), settler.deadlineMs);
	});
	const outcome = await Promise.race([settler.settled().then(() => "settled" as const), expired]);
	clearTimeout(timer);
	if (outcome === "expired")
		return `${directory}: ${settler.writer()} did not finish within ${settler.deadlineMs} ms; left in place`;
	await rm(directory, { recursive: true, force: true });
	return undefined;
}
// File-scoped fixtures may be created at module evaluation, before any test is active.
// Vitest setup registers teardown; real subprocess fixtures keep their explicit cleanup.
// The removal is awaited so a package's test setup can join work still writing into a tracked tree first
// (coding-agent waits for in-flight host gc passes, senpi#4382); a synchronous removal could not wait.
/** Removes one settle-tracked directory now, after its writer finished; throws naming the writer on the deadline. */
export async function removeSettledTempDir(directory: string): Promise<void> {
	const settler = settlers.get(directory);
	if (settler === undefined) throw new Error(`${directory} has no settle-before-removal registration`);
	settlers.delete(directory);
	directories.delete(directory);
	const failure = await settleThenRemove(directory, settler);
	if (failure !== undefined) throw new Error(failure);
}

export async function cleanupTempDirs(): Promise<void> {
	for (const cleanup of [...cleanups].reverse()) cleanup();
	const failures: string[] = [];
	for (const [directory, settler] of [...settlers]) {
		settlers.delete(directory);
		directories.delete(directory);
		const failure = await settleThenRemove(directory, settler);
		if (failure !== undefined) failures.push(failure);
	}
	for (const directory of directories) {
		await rm(directory, { recursive: true, force: true, maxRetries: 3 });
		directories.delete(directory);
	}
	if (failures.length > 0) throw new Error(`temp directories still being written:\n${failures.join("\n")}`);
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
