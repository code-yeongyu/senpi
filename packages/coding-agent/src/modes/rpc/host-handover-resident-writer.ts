/**
 * The process that holds a retained session resident (senpi#6190). A host records each retained session it has
 * open, stamped with this writer, so the next host on the endpoint can restore it after a crash; while that
 * writer is still alive (a generation handoff's draining predecessor) the session is not its successor's to
 * reopen - the predecessor parks it, and the unstamped park is what the successor consumes. Liveness follows the
 * session writer claims: same host, same boot, live pid whose start time matches.
 */
import { BOOT_INSTANT_TOLERANCE_MS, sameBoot } from "../../core/extensions/builtin/terminal/process-identity.ts";
import { sameProcessKey } from "../../core/extensions/builtin/terminal/process-key.ts";
import { realWriterProbes, type WriterProbes } from "../../core/session-writer-claims.ts";

export interface ResidentWriter {
	readonly host: string;
	readonly pid: number;
	readonly bootAtMs: number;
	readonly processStartedAtMs: number;
	readonly processKey?: string;
}

export async function currentResidentWriter(probes: WriterProbes = realWriterProbes): Promise<ResidentWriter> {
	const bootAtMs = await probes.bootAtMs();
	const self = probes.self();
	const processKey = await probes.readProcessKey?.(self.pid);
	return {
		host: probes.host(),
		pid: self.pid,
		bootAtMs,
		processStartedAtMs: self.processStartedAtMs,
		...(processKey === undefined ? {} : { processKey }),
	};
}

export function isResidentWriter(value: unknown): value is ResidentWriter {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.host === "string" &&
		Number.isInteger(record.pid) &&
		typeof record.bootAtMs === "number" &&
		typeof record.processStartedAtMs === "number" &&
		(record.processKey === undefined || typeof record.processKey === "string")
	);
}

/**
 * A liveness probe for one reopen watch, which polls: a writer found gone stays gone, and a live pid's start time
 * (a process spawn on some platforms) is read once. A writer on another host cannot be probed from here, so it is
 * never displaced.
 */
async function sameBootReading(probes: WriterProbes, recordedBootAtMs: number): Promise<boolean> {
	if (sameBoot(await probes.bootAtMs(), recordedBootAtMs)) return true;
	return sameBoot(await probes.bootAtMs({ fresh: true }), recordedBootAtMs);
}

export function residentWriterProbe(
	probes: WriterProbes = realWriterProbes,
): (writer: ResidentWriter) => Promise<boolean> {
	const gone = new Set<string>();
	const verified = new Set<string>();
	return async (writer) => {
		const key = `${writer.host}:${writer.pid}:${writer.processStartedAtMs}`;
		// A writer found gone stays gone: the set only grows, so this sync check needs no boot read, and a reopen watch
		// polling a gone writer never re-reads the kernel record (a `sysctl` spawn on macOS) on every poll.
		if (gone.has(key)) return false;
		if (writer.host !== probes.host()) return true;
		if (!probes.pidAlive(writer.pid)) {
			gone.add(key);
			return false;
		}
		// A verified writer is re-checked by its pid alone: no boot or start read on every poll (a spawn on macOS).
		if (verified.has(key)) return true;
		// A step-invariant key decides exactly where both sides have one. Without keys a live pid is judged by its start
		// time first (a wall-clock step moves the boot instant), and the boot instant only when the start time is
		// unreadable; that read is checked against a fresh one, since a step makes the cached record stale.
		const byKey =
			writer.processKey === undefined
				? undefined
				: sameProcessKey(writer.processKey, await probes.readProcessKey?.(writer.pid));
		const startedAtMs = byKey === undefined ? await probes.readProcessStartMs(writer.pid) : undefined;
		const sameProcess =
			byKey ??
			(startedAtMs !== undefined
				? Math.abs(startedAtMs - writer.processStartedAtMs) <= BOOT_INSTANT_TOLERANCE_MS
				: await sameBootReading(probes, writer.bootAtMs));
		if (gone.has(key)) return false;
		if (!sameProcess) {
			gone.add(key);
			return false;
		}
		verified.add(key);
		return true;
	};
}
