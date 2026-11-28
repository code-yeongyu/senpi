/**
 * The record the budgeted gc pass (`host-gc-pass.ts`) keeps between passes, one per agent directory:
 * when the last pass COMPLETED (the 5 min rate limit), where its fair rotation stopped (`cursor`, the
 * last endpoint directory it examined), and which endpoints proved uncollectable and are left alone
 * until `skipUntil` (backoff doubling from 10 min to 24 h).
 *
 * It lives in the flat daemon directory beside `layout.json`; `listHostEndpoints` only lists 16-hex
 * directories, so the file is never mistaken for an endpoint. Written by rename, so a reader sees the
 * previous record or the next one, never a torn one; a record that does not parse reads as "no pass
 * has run yet". The staged `gc-last-run.json.<pid>.tmp` never outlives its writer (senpi#7564): a process that
 * exits between the write and the rename (a short-lived CLI under its unref'd pass) unlinks it on exit, and a
 * pass removes any whose writer is no longer running (SIGKILL).
 */
import { rmSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type HuskProbe, processRecordLive } from "./host-gc-husk.ts";

export const GC_SKIP_INITIAL_BACKOFF_MS = 10 * 60_000;
export const GC_SKIP_MAX_BACKOFF_MS = 24 * 60 * 60_000;

const skipEntrySchema = z.object({ skipUntil: z.number(), backoffMs: z.number() });

const markerSchema = z.object({
	completedAt: z.number(),
	cursor: z.string().nullable(),
	examined: z.number(),
	removed: z.number(),
	stoppedBy: z.enum(["time", "count", "exhausted"]),
	skip: z.record(z.string(), skipEntrySchema),
});

export type HostGcPassMarker = z.infer<typeof markerSchema>;
export type HostGcSkipEntry = z.infer<typeof skipEntrySchema>;

export function hostGcPassMarkerPath(agentDir: string): string {
	return join(agentDir, "rpc-host-daemon", "gc-last-run.json");
}

export function parseHostGcPassMarker(text: string): HostGcPassMarker | undefined {
	try {
		const parsed = markerSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : undefined;
	} catch (error: unknown) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export async function readHostGcPassMarker(agentDir: string): Promise<HostGcPassMarker | undefined> {
	const text = await readFile(hostGcPassMarkerPath(agentDir), "utf8").catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	});
	return text === undefined ? undefined : parseHostGcPassMarker(text);
}

export async function writeHostGcPassMarker(agentDir: string, marker: HostGcPassMarker): Promise<void> {
	const path = hostGcPassMarkerPath(agentDir);
	const staged = `${path}.${process.pid}.tmp`;
	const discardStaged = (): void => rmSync(staged, { force: true });
	process.once("exit", discardStaged);
	try {
		await writeFile(staged, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
		await rename(staged, path);
	} finally {
		process.removeListener("exit", discardStaged);
	}
}

/** Removes every staged marker whose writer is no longer running; a live writer's is still being renamed in. */
export async function sweepStagedMarkers(
	agentDir: string,
	pidLive: HuskProbe["pidLive"] = processRecordLive,
): Promise<void> {
	const flatDir = join(agentDir, "rpc-host-daemon");
	for (const name of await readdir(flatDir).catch(() => [] as string[])) {
		const pid = /^gc-last-run\.json\.(\d+)\.tmp$/.exec(name)?.[1];
		if (pid === undefined || (await pidLive({ pid: Number(pid), processStartTime: null }))) continue;
		await rm(join(flatDir, name), { force: true });
	}
}

/** The next skip for an endpoint that stayed uncollectable: 10 min first, doubling, capped at 24 h. */
export function nextSkip(previous: HostGcSkipEntry | undefined, now: number): HostGcSkipEntry {
	const backoffMs =
		previous === undefined ? GC_SKIP_INITIAL_BACKOFF_MS : Math.min(previous.backoffMs * 2, GC_SKIP_MAX_BACKOFF_MS);
	return { skipUntil: now + backoffMs, backoffMs };
}
