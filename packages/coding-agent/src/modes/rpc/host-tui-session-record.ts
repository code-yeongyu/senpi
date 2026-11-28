/**
 * The session a `tui` endpoint holds, on disk: the one record that survives an unclean terminal
 * exit (senpi#2680). Registration writes it into the endpoint directory next to `endpoint.json`,
 * under the same ensure lock as the generation record; a clean exit removes it with the directory,
 * and `host gc` removes it the same way. `host status --all` reads it only as a FALLBACK - a
 * terminal that answers names its session through `list_sessions` - and only when the record's
 * `pid` and `processStartTime` match the endpoint's current generation, so a terminal reusing a
 * socket path never inherits the session the previous one held.
 */
import { rename } from "node:fs/promises";
import type { HostDaemonDirectory } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined, writeStateFile } from "./host-daemon-state.ts";

/** The session a terminal's registration names: exactly what its live `list_sessions` row says. */
export interface TuiEndpointSession {
	readonly id: string;
	readonly path: string | null;
	readonly name: string | null;
	readonly cwd: string | null;
}

/** The recorded session, stamped with the generation that wrote it. */
export interface TuiSessionRecord extends TuiEndpointSession {
	readonly pid: number;
	readonly processStartTime: string | null;
}

/** Writes the record whole (temporary name, rename into place), so a reader never sees it torn. */
export async function writeTuiSessionRecord(
	paths: HostDaemonDirectory,
	session: TuiEndpointSession,
	owner: { readonly pid: number; readonly processStartTime: string | null },
): Promise<void> {
	const temporary = `${paths.tuiSessionFile}.${process.pid}.tmp`;
	await writeStateFile(temporary, { ...session, pid: owner.pid, processStartTime: owner.processStartTime });
	await rename(temporary, paths.tuiSessionFile);
}

/** The recorded session, or nothing when the directory holds none a reader may trust. */
export async function readTuiSessionRecord(paths: HostDaemonDirectory): Promise<TuiSessionRecord | undefined> {
	const parsed = parseJson(await readFileOrUndefined(paths.tuiSessionFile));
	if (parsed === undefined || typeof parsed.id !== "string" || parsed.id === "") return undefined;
	if (typeof parsed.pid !== "number") return undefined;
	return {
		id: parsed.id,
		path: typeof parsed.path === "string" ? parsed.path : null,
		name: typeof parsed.name === "string" ? parsed.name : null,
		cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
		pid: parsed.pid,
		processStartTime: typeof parsed.processStartTime === "string" ? parsed.processStartTime : null,
	};
}

/** The record names this generation exactly when its pid AND processStartTime match it. */
export function tuiSessionRecordMatches(
	record: TuiSessionRecord,
	generation: { readonly pid: number; readonly processStartTime: string | null },
): boolean {
	return record.pid === generation.pid && record.processStartTime === generation.processStartTime;
}
