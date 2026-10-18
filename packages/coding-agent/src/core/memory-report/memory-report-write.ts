import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { buildMemoryReport } from "./memory-report-build.ts";
import {
	type MemoryReportSessionSource,
	memoryReportEnabled,
	memoryReportSessions,
	memoryReportSnapshotEnabled,
} from "./memory-report-registry.ts";

export type MemoryReportOutcome =
	| { readonly ok: true; readonly path: string; readonly heapSnapshot?: string }
	| { readonly ok: false; readonly error: string };

/** `<session>.jsonl` keeps its reports in `<session>-artifacts/memory/`, beside the eval artifacts. */
export function memoryReportDir(sessionFile: string | undefined, sessionId?: string): string {
	if (sessionFile === undefined) {
		// Unsaved sessions share the pid fallback, so key it per session or same-stamp reports overwrite.
		const suffix = sessionId === undefined ? "" : `-${sessionId}`;
		return join(tmpdir(), `senpi-memory-report-${process.pid}${suffix}`);
	}
	const base = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile;
	return join(`${base}-artifacts`, "memory");
}

/**
 * Writes one report per session into its artifacts directory, and at most one heap snapshot (with the
 * snapshot flag) shared by every report of this request. A failure is one stderr line and an error
 * outcome for that session, never a throw: the report must not take the session down.
 */
export async function writeMemoryReports(
	sources: readonly MemoryReportSessionSource[],
): Promise<MemoryReportOutcome[]> {
	const stamp = new Date().toISOString().replaceAll(":", "-");
	const outcomes: MemoryReportOutcome[] = [];
	let snapshot: string | undefined;
	for (const source of sources) {
		try {
			const dir = memoryReportDir(source.sessionFile(), source.sessionId());
			await mkdir(dir, { recursive: true });
			if (snapshot === undefined && memoryReportSnapshotEnabled()) {
				snapshot = await writeSnapshot(join(dir, `${stamp}.heapsnapshot`));
			}
			const path = join(dir, `${stamp}.json`);
			await writeFile(`${path}.tmp`, `${JSON.stringify(buildMemoryReport(source, snapshot), null, 2)}\n`);
			await rename(`${path}.tmp`, path);
			outcomes.push({ ok: true, path, ...(snapshot === undefined ? {} : { heapSnapshot: snapshot }) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`senpi memory report: session ${source.sessionId()} not written: ${message}\n`);
			outcomes.push({ ok: false, error: message });
		}
	}
	return outcomes;
}

/** Installs the `SIGUSR2` trigger when the flag is on (POSIX only); otherwise installs nothing. */
export function installMemoryReportSignal(): () => void {
	if (!memoryReportEnabled() || process.platform === "win32") return () => {};
	const onSignal = (): void => {
		const sources = memoryReportSessions();
		if (sources.length === 0) process.stderr.write("senpi memory report: no live session to report\n");
		void writeMemoryReports(sources);
	};
	process.on("SIGUSR2", onSignal);
	return () => process.off("SIGUSR2", onSignal);
}

/** Bun writes its own V8-format snapshot of the main thread; Node writes through `node:v8`. */
async function writeSnapshot(path: string): Promise<string> {
	const bun: unknown = Reflect.get(globalThis, "Bun");
	const generate: unknown =
		typeof bun === "object" && bun !== null ? Reflect.get(bun, "generateHeapSnapshot") : undefined;
	if (typeof generate !== "function") return writeHeapSnapshot(path);
	const snapshot: unknown = Reflect.apply(generate, bun, ["v8"]);
	if (typeof snapshot !== "string") throw new Error("Bun.generateHeapSnapshot did not return a V8 snapshot");
	await writeFile(path, snapshot);
	return path;
}
