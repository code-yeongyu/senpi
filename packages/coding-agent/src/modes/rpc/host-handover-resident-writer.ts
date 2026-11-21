/**
 * The process that holds a retained session resident (senpi#6190). A host records each retained session it has
 * open, stamped with this writer, so the next host on the endpoint can restore it after a crash; while that
 * writer is still alive (a generation handoff's draining predecessor) the session is not its successor's to
 * reopen - the predecessor parks it, and the unstamped park is what the successor consumes. Liveness follows the
 * session writer claims: same host, same boot, live pid whose start time matches.
 */
import { BOOT_INSTANT_TOLERANCE_MS, sameBoot } from "../../core/extensions/builtin/terminal/process-identity.ts";
import { realWriterProbes, type WriterProbes } from "../../core/session-writer-claims.ts";

export interface ResidentWriter {
	readonly host: string;
	readonly pid: number;
	readonly bootAtMs: number;
	readonly processStartedAtMs: number;
}

export async function currentResidentWriter(probes: WriterProbes = realWriterProbes): Promise<ResidentWriter> {
	const bootAtMs = await probes.bootAtMs();
	const self = probes.self();
	return {
		host: probes.host(),
		pid: self.pid,
		bootAtMs,
		processStartedAtMs: self.processStartedAtMs,
	};
}

export function isResidentWriter(value: unknown): value is ResidentWriter {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.host === "string" &&
		Number.isInteger(record.pid) &&
		typeof record.bootAtMs === "number" &&
		typeof record.processStartedAtMs === "number"
	);
}

/**
 * A liveness probe for one reopen watch, which polls: a writer found gone stays gone, and a live pid's start time
 * (a process spawn on some platforms) is read once. A writer on another host cannot be probed from here, so it is
 * never displaced.
 */
export function residentWriterProbe(
	probes: WriterProbes = realWriterProbes,
): (writer: ResidentWriter) => Promise<boolean> {
	const gone = new Set<string>();
	const verified = new Set<string>();
	return async (writer) => {
		// Resolved first, so nothing yields between reading the verdict cache and recording a new verdict; a writer that
		// looks like another boot is checked against a fresh read, since a wall-clock step makes the cached record stale.
		let bootAtMs = await probes.bootAtMs();
		if (writer.host === probes.host() && !sameBoot(bootAtMs, writer.bootAtMs))
			bootAtMs = await probes.bootAtMs({ fresh: true });
		const key = `${writer.host}:${writer.pid}:${writer.processStartedAtMs}`;
		if (gone.has(key)) return false;
		if (writer.host !== probes.host()) return true;
		if (!sameBoot(bootAtMs, writer.bootAtMs) || !probes.pidAlive(writer.pid)) {
			gone.add(key);
			return false;
		}
		if (verified.has(key)) return true;
		const startedAtMs = await probes.readProcessStartMs(writer.pid);
		if (startedAtMs !== undefined && Math.abs(startedAtMs - writer.processStartedAtMs) > BOOT_INSTANT_TOLERANCE_MS) {
			gone.add(key);
			return false;
		}
		verified.add(key);
		return true;
	};
}
